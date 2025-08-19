'use strict';

const express = require('express');
const soap = require('soap');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const { qbwcServiceFactory } = require('./services/qbwcService');

/* ====== Config ====== */
const PORT = process.env.PORT || 8080;                 // Azure Linux usa 8080
const BASE_PATH = process.env.BASE_PATH || '/qbwc';
const TNS = 'http://developer.intuit.com/';
const LOG_DIR = process.env.LOG_DIR || '/tmp';         // <— usamos /tmp para asegurar escritura

/* ====== Helpers de archivos ====== */
function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}
function fp(name) { return path.join(LOG_DIR, name); }
function sendFileSmart(res, filePath) {
  if (!fs.existsSync(filePath)) return res.status(404).send('not found');
  const txt = fs.readFileSync(filePath, 'utf8');
  res.type(txt.trim().startsWith('<') ? 'application/xml' : 'text/plain').send(txt);
}
ensureLogDir();

/* ====== App ====== */
const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

/* ====== Debug/health ====== */
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

app.get('/debug/config', (_req, res) => {
  res.json({
    user: process.env.WC_USERNAME || null,
    passLen: (process.env.WC_PASSWORD || '').length,
    basePath: BASE_PATH,
    logDir: LOG_DIR
  });
});

app.get('/debug/where', (_req, res) => {
  try {
    ensureLogDir();
    const list = fs.readdirSync(LOG_DIR).map(f => {
      const st = fs.statSync(path.join(LOG_DIR, f));
      return { name: f, size: st.size, mtime: st.mtime };
    });
    res.json({ logDir: LOG_DIR, files: list });
  } catch (e) {
    res.status(500).send(String(e));
  }
});

app.get('/debug/last-response', (req, res) => {
  try { sendFileSmart(res, fp('qbwc-last-response.xml')); }
  catch (e) { res.status(500).send(String(e)); }
});
app.get('/debug/last-auth-request', (req, res) => {
  try { sendFileSmart(res, fp('last-auth-request.xml')); }
  catch (e) { res.status(500).send(String(e)); }
});
app.get('/debug/last-auth-response', (req, res) => {
  try { sendFileSmart(res, fp('last-auth-response.xml')); }
  catch (e) { res.status(500).send(String(e)); }
});
app.get('/debug/last-post-body', (req, res) => {
  try { sendFileSmart(res, fp('last-post-body.xml')); }
  catch (e) { res.status(500).send(String(e)); }
});
app.get('/debug/last-auth-cred', (req, res) => {
  try {
    const p = fp('last-auth-cred.json');
    if (!fs.existsSync(p)) return res.status(404).send('no auth cred yet');
    res.type('application/json').send(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    res.status(500).send(String(e));
  }
});

/* ====== OVERRIDE authenticate (agnóstico a SOAPAction) ====== */
app.post(BASE_PATH, (req, res, next) => {
  const wantsAuthByHeader =
    (req.headers['soapaction'] || '').toLowerCase().includes('authenticate');

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    ensureLogDir();
    try { fs.writeFileSync(fp('last-post-body.xml'), raw || '', 'utf8'); } catch {}

    const wantsAuthByBody = raw.includes('<authenticate') || raw.includes(':authenticate');
    if (!wantsAuthByHeader && !wantsAuthByBody) {
      // En esta fase de depuración, respondemos 200 para no romper nada.
      return res.status(200).send('OK');
    }

    try {
      try { fs.writeFileSync(fp('last-auth-request.xml'), raw || '', 'utf8'); } catch {}

      // Extrae user/pass (regex simple, tolerante a prefijos)
      const user = (raw.match(/<\w*:strUserName>([^<]*)<\/\w*:strUserName>/) || [])[1] || '';
      const pass = (raw.match(/<\w*:strPassword>([^<]*)<\/\w*:strPassword>/) || [])[1] || '';

      const envUser = process.env.WC_USERNAME || '';
      const envPass = process.env.WC_PASSWORD || '';

      console.log(`[QBWC] auth attempt user="${user}" matchUser=${user === envUser} passLen=${pass.length}`);

      // Guarda hashes/longitudes para validar sin filtrar la clave
      try {
        const passSha = crypto.createHash('sha256').update(pass, 'utf8').digest('hex');
        const envSha  = crypto.createHash('sha256').update(envPass, 'utf8').digest('hex');
        const debugObj = {
          ts: new Date().toISOString(),
          receivedUser: user,
          receivedPassLen: pass.length,
          receivedPassSha256: passSha,
          envUser: envUser,
          envPassLen: envPass.length,
          envPassSha256: envSha,
          matchUser: user === envUser,
          matchPassHash: passSha === envSha
        };
        fs.writeFileSync(fp('last-auth-cred.json'), JSON.stringify(debugObj, null, 2), 'utf8');
      } catch (e) {
        console.error('failed to save last-auth-cred:', e);
      }

      const ok = (user === envUser && pass === envPass);
      const ticket = ok
        ? (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'))
        : '';

      const payload = ok
        ? `<string>${ticket}</string><string>none</string>`
        : `<string></string><string>nvu</string>`;

      // Sobre SOAP canónico (xmlns por defecto en authenticateResponse)
      const envelope =
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
        `  <soap:Body>` +
        `    <authenticateResponse xmlns="${TNS}">` +
        `      <authenticateResult>${payload}</authenticateResult>` +
        `    </authenticateResponse>` +
        `  </soap:Body>` +
        `</soap:Envelope>`;

      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      res.setHeader('SOAPAction', `${TNS}authenticate`);
      res.status(200).send(envelope);

      try { fs.writeFileSync(fp('last-auth-response.xml'), envelope, 'utf8'); } catch {}
    } catch (err) {
      console.error('authenticate override error:', err);
      res.status(500).send(String(err));
    }
  });
});

/* ====== SOAP server (resto de operaciones) ====== */
const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
const wsdlXml = fs.readFileSync(wsdlPath, 'utf8');
const serviceObject = qbwcServiceFactory();

const server = app.listen(PORT, () => {
  console.log(`[QBWC SOAP] Listening on http://localhost:${PORT}${BASE_PATH}`);
});

// Montamos node-soap DESPUÉS del override
const soapServer = soap.listen(server, BASE_PATH, serviceObject, wsdlXml);

// Log de respaldo (si llega por node-soap)
function safeToString(payload) {
  if (payload == null) return '';
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  if (typeof payload === 'string') return payload;
  try { return JSON.stringify(payload, null, 2); } catch { return String(payload); }
}
soapServer.log = (type, data) => {
  try {
    if (type === 'received') {
      const xml = safeToString(data);
      if (xml.includes('<authenticate')) {
        fs.writeFileSync(fp('last-auth-request.xml'), xml, 'utf8');
      }
    }
  } catch (e) {
    console.error('[SOAP log hook] error:', e);
  }
};
