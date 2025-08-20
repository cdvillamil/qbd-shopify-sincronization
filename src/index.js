'use strict';

const express = require('express');
const soap = require('soap');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const { qbwcServiceFactory } = require('./services/qbwcService');

/* ===== Config ===== */
const PORT = process.env.PORT || 8080;             // Azure Linux usa 8080
const BASE_PATH = process.env.BASE_PATH || '/qbwc';
const TNS = 'http://developer.intuit.com/';
const LOG_DIR = process.env.LOG_DIR || '/tmp';     // Carpeta de logs (escribible en App Service Linux)

/* ===== Utils ===== */
function ensureLogDir() { try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {} }
function fp(name) { return path.join(LOG_DIR, name); }
function sendFileSmart(res, filePath) {
  if (!fs.existsSync(filePath)) return res.status(404).send('not found');
  const txt = fs.readFileSync(filePath, 'utf8');
  const looksXml = txt.trim().startsWith('<');
  const looksJson = txt.trim().startsWith('{') || txt.trim().startsWith('[');
  res.type(looksXml ? 'application/xml' : looksJson ? 'application/json' : 'text/plain').send(txt);
}
function toPretty(any) {
  if (any == null) return '';
  if (typeof any === 'string') return any;
  try { return JSON.stringify(any, null, 2); } catch { return String(any); }
}
function extractCreds(payload) {
  let user = '', pass = '';

  if (payload && typeof payload === 'object') {
    const env = payload.Envelope || payload.envelope || payload;
    const body = env?.Body || env?.body || payload.Body || payload.body || payload;
    const auth = body?.authenticate || body?.Authenticate || payload.authenticate || payload.Authenticate;
    if (auth) {
      user = auth.strUserName || auth.userName || auth.UserName || '';
      pass = auth.strPassword || auth.password || auth.Password || '';
    }
  }

  if ((!user && !pass) && typeof payload === 'string') {
    const s = payload.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try {
        const obj = JSON.parse(s);
        const r = extractCreds(obj);
        user = r.user || user;
        pass = r.pass || pass;
      } catch {}
    }
    if (!user && !pass) {
      const u = s.match(/<(?:\w*:)?(?:strUserName|userName|UserName)>([^<]*)<\/(?:\w*:)?(?:strUserName|userName|UserName)>/);
      const p = s.match(/<(?:\w*:)?(?:strPassword|password|Password)>([^<]*)<\/(?:\w*:)?(?:strPassword|password|Password)>/);
      user = (u && u[1]) || user || '';
      pass = (p && p[1]) || pass || '';
    }
  }

  return { user, pass };
}
ensureLogDir();

/* ===== App ===== */
const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

/* Health & Debug */
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
    const files = fs.readdirSync(LOG_DIR).map(name => {
      const st = fs.statSync(fp(name));
      return { name, size: st.size, mtime: st.mtime };
    });
    res.json({ logDir: LOG_DIR, files });
  } catch (e) { res.status(500).send(String(e)); }
});
app.get('/debug/last-post-body', (req, res) => {
  try { sendFileSmart(res, fp('last-post-body.xml')); }
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
app.get('/debug/last-auth-cred', (req, res) => {
  try {
    const p = fp('last-auth-cred.json');
    if (!fs.existsSync(p)) return res.status(404).send('no auth cred yet');
    res.type('application/json').send(fs.readFileSync(p, 'utf8'));
  } catch (e) { res.status(500).send(String(e)); }
});
app.get('/debug/last-response', (req, res) => {
  try { sendFileSmart(res, fp('qbwc-last-response.xml')); }
  catch (e) { res.status(500).send(String(e)); }
});

/* ========= OVERRIDE SOLO authenticate (respuesta con namespace por defecto) ========= */
app.post(BASE_PATH, (req, res, next) => {
  // Capturamos el cuerpo tal cual llega
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    try {
      ensureLogDir();
      fs.writeFileSync(fp('last-post-body.xml'), raw || '', 'utf8');

      const soapAction = (req.headers['soapaction'] || '').toLowerCase();
      const looksAuth = soapAction.includes('authenticate') || raw.includes('<authenticate') || raw.includes('"authenticate"');

      if (!looksAuth) {
        // No es authenticate -> lo dejamos pasar al soap server
        return next();
      }

      // Guardamos request específico
      fs.writeFileSync(fp('last-auth-request.xml'), raw || '', 'utf8');

      // Puede venir como XML o como JSON (dependiendo del stack); intentamos parsear JSON si aplica
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {}

      // Extraemos credenciales de forma robusta
      const { user, pass } = extractCreds(parsed || raw);

      // Comprobamos contra env
      const envUser = process.env.WC_USERNAME || '';
      const envPass = process.env.WC_PASSWORD || '';
      const ok = (user === envUser && pass === envPass);

      const passSha = crypto.createHash('sha256').update(pass || '', 'utf8').digest('hex');
      const envSha  = crypto.createHash('sha256').update(envPass, 'utf8').digest('hex');
      const debugObj = {
        ts: new Date().toISOString(),
        receivedUser: user,
        receivedPassLen: (pass || '').length,
        receivedPassSha256: passSha,
        envUser: envUser,
        envPassLen: envPass.length,
        envPassSha256: envSha,
        matchUser: user === envUser,
        matchPassHash: passSha === envSha
      };
      fs.writeFileSync(fp('last-auth-cred.json'), JSON.stringify(debugObj, null, 2), 'utf8');
      console.log(`[QBWC] auth attempt user="${user}" ok=${ok}`);

      // Ticket y payload
      const ticket = ok
        ? (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'))
        : '';

      const payload = ok
        ? `<string>${ticket}</string><string>none</string>`
        : `<string></string><string>nvu</string>`;

      // *** RESPUESTA con NAMESPACE POR DEFECTO (sin prefijo) ***
      const envelope =
        `<?xml version="1.0" encoding="utf-8"?>` +
        `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
        `  <soap:Body>` +
        `    <authenticateResponse xmlns="http://developer.intuit.com/">` +
        `      <authenticateResult>${payload}</authenticateResult>` +
        `    </authenticateResponse>` +
        `  </soap:Body>` +
        `</soap:Envelope>`;

      res.setHeader('Content-Type', 'text/xml; charset=utf-8');
      res.setHeader('SOAPAction', 'http://developer.intuit.com/authenticate');
      res.status(200).send(envelope);

      fs.writeFileSync(fp('last-auth-response.xml'), envelope, 'utf8');
    } catch (e) {
      console.error('authenticate override error:', e);
      res.status(500).send(String(e));
    }
  });
});

/* ===== SOAP server para el resto de métodos ===== */
const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
const wsdlXml = fs.readFileSync(wsdlPath, 'utf8');
const serviceObject = qbwcServiceFactory();

const server = app.listen(PORT, () => {
  console.log(`[QBWC SOAP] Listening on http://localhost:${PORT}${BASE_PATH}`);
});
const soapServer = soap.listen(server, BASE_PATH, serviceObject, wsdlXml);

/* ===== Hooks de node-soap (logs de request/response para otros métodos) ===== */
soapServer.on('request', (payload, methodName) => {
  try {
    ensureLogDir();
    const raw = toPretty(payload);
    fs.writeFileSync(fp('last-post-body.xml'), raw || '', 'utf8');

    // Si por alguna razón authenticate no pasó por el override, igual lo registramos
    const isAuth = (methodName || '').toLowerCase() === 'authenticate'
                || raw.includes('<authenticate') || raw.includes('"authenticate"');
    if (isAuth) fs.writeFileSync(fp('last-auth-request.xml'), raw || '', 'utf8');
  } catch (e) {
    console.error('[SOAP hook:request] error:', e);
  }
});

soapServer.on('response', (xml, methodName) => {
  try {
    ensureLogDir();
    const body = typeof xml === 'string' ? xml : toPretty(xml);
    fs.writeFileSync(fp('qbwc-last-response.xml'), body || '', 'utf8');
    if ((methodName || '').toLowerCase() === 'authenticate' || body.includes('<authenticateResponse')) {
      fs.writeFileSync(fp('last-auth-response.xml'), body || '', 'utf8');
    }
  } catch (e) {
    console.error('[SOAP hook:response] error:', e);
  }
});
