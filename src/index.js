'use strict';

const express = require('express');
const soap = require('soap');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const { qbwcServiceFactory } = require('./services/qbwcService');

const PORT = process.env.PORT || 8080;               // Azure usa 8080 en Linux
const BASE_PATH = process.env.BASE_PATH || '/qbwc';
const TNS = 'http://developer.intuit.com/';

const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

/* ---------- Log persistente de TODA request a /qbwc ---------- */
app.use(BASE_PATH, (req, res, next) => {
  try {
    fs.appendFileSync(
      '/home/LogFiles/qbwc.log',
      `${new Date().toISOString()} ${req.method} ${req.originalUrl}\n`
    );
  } catch {}
  next();
});

/* ---------- TAP de respuesta: guarda el body real del POST ---------- */
app.use((req, res, next) => {
  if (!req.originalUrl.startsWith(BASE_PATH)) return next();

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const chunks = [];

  res.write = (chunk, ...args) => {
    try { if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); } catch {}
    return originalWrite(chunk, ...args);
  };

  res.end = (chunk, ...args) => {
    try {
      if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'POST' && req.originalUrl.startsWith(BASE_PATH)) {
        fs.writeFileSync('/home/LogFiles/last-post-body.xml', body || '', 'utf8');
        if (body.includes('<authenticateResponse')) {
          fs.writeFileSync('/home/LogFiles/last-auth-response.xml', body, 'utf8');
        }
      }
    } catch (e) {
      console.error('[DEBUG] tap response error:', e);
    }
    return originalEnd(chunk, ...args);
  };

  next();
});

/* ---------------- Helpers ---------------- */
function sendFileSmart(res, filePath) {
  if (!fs.existsSync(filePath)) return res.status(404).send('not found');
  const txt = fs.readFileSync(filePath, 'utf8');
  res.type(txt.trim().startsWith('<') ? 'application/xml' : 'text/plain').send(txt);
}

/* ---------------- Health & Debug ---------------- */
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

app.get('/debug/config', (_req, res) => {
  res.json({
    user: process.env.WC_USERNAME || null,
    passLen: (process.env.WC_PASSWORD || '').length,
    basePath: BASE_PATH
  });
});

app.get('/debug/last-response', (req, res) => {
  try { sendFileSmart(res, '/tmp/qbwc-last-response.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

app.get('/debug/last-auth-request', (req, res) => {
  try { sendFileSmart(res, '/home/LogFiles/last-auth-request.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

app.get('/debug/last-auth-response', (req, res) => {
  try { sendFileSmart(res, '/home/LogFiles/last-auth-response.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

app.get('/debug/last-post-body', (req, res) => {
  try { sendFileSmart(res, '/home/LogFiles/last-post-body.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

app.get('/debug/last-auth-cred', (req, res) => {
  try {
    const p = '/home/LogFiles/last-auth-cred.json';
    if (!fs.existsSync(p)) return res.status(404).send('no auth cred yet');
    res.type('application/json').send(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    res.status(500).send(String(e));
  }
});

/* ---------------- OVERRIDE de authenticate ----------------
   - Detecta SOLO por SOAPAction (no toca el stream si no es authenticate)
   - Lee el body crudo SOLO cuando es authenticate
----------------------------------------------------------- */
app.post(BASE_PATH, (req, res, next) => {
  const soapAction = (req.headers['soapaction'] || '').toLowerCase();
  const isAuth = soapAction.includes('authenticate');

  if (!isAuth) return next(); // no consumimos el stream → deja a node-soap manejarlo

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    try {
      // Guarda el REQUEST real
      try { fs.writeFileSync('/home/LogFiles/last-auth-request.xml', raw || '', 'utf8'); } catch {}

      // Extrae user/pass simples (sin parser pesado)
      const user = (raw.match(/<\w*:strUserName>([^<]*)<\/\w*:strUserName>/) || [])[1] || '';
      const pass = (raw.match(/<\w*:strPassword>([^<]*)<\/\w*:strPassword>/) || [])[1] || '';

      const envUser = process.env.WC_USERNAME || '';
      const envPass = process.env.WC_PASSWORD || '';

      // Log de intento
      console.log(`[QBWC] auth attempt user="${user}" matchUser=${user === envUser} passLen=${pass.length}`);

      // Guarda hashes y longitudes para verificación sin exponer la clave
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
        fs.writeFileSync('/home/LogFiles/last-auth-cred.json', JSON.stringify(debugObj, null, 2), 'utf8');
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

      // Sobre SOAP canónico: namespace por DEFECTO en authenticateResponse
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

      // También guarda el response por si el tap fallara
      try { fs.writeFileSync('/home/LogFiles/last-auth-response.xml', envelope, 'utf8'); } catch {}

    } catch (err) {
      console.error('authenticate override error:', err);
      // Si algo sale mal, dejamos pasar a node-soap
      return next();
    }
  });
});

/* ---------------- SOAP server (resto de operaciones) ---------------- */
const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
const wsdlXml = fs.readFileSync(wsdlPath, 'utf8');
const serviceObject = qbwcServiceFactory();

const server = app.listen(PORT, () => {
  console.log(`[QBWC SOAP] Listening on http://localhost:${PORT}${BASE_PATH}`);
});

// IMPORTANTE: montar node-soap DESPUÉS del override
const soapServer = soap.listen(server, BASE_PATH, serviceObject, wsdlXml);

/* ---- Hook del paquete "soap": capturar authenticate REQUEST (respaldo) ---- */
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
        fs.writeFileSync('/home/LogFiles/last-auth-request.xml', xml, 'utf8');
      }
    }
  } catch (e) {
    console.error('[SOAP log hook] error:', e);
  }
};
