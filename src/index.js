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
const LOG_DIR = process.env.LOG_DIR || '/tmp';     // Carpeta de logs (escribible en App Service Linux)

/* ===== Utils ===== */
function ensureLogDir() { try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {} }
function fp(name) { return path.join(LOG_DIR, name); }
function sendFileSmart(res, filePath) {
  if (!fs.existsSync(filePath)) return res.status(404).send('not found');
  const txt = fs.readFileSync(filePath, 'utf8');
  const looksXml = txt.trim().startsWith('<');
  const looksJson = txt.trim().startsWith('{') || txt.trim().startsWith('[');
  res
    .type(looksXml ? 'application/xml' : looksJson ? 'application/json' : 'text/plain')
    .send(txt);
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
  } catch (e) {
    res.status(500).send(String(e));
  }
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
  } catch (e) {
    res.status(500).send(String(e));
  }
});

app.get('/debug/last-response', (req, res) => {
  try { sendFileSmart(res, fp('qbwc-last-response.xml')); }
  catch (e) { res.status(500).send(String(e)); }
});

/* ===== SOAP server (todo el flujo) ===== */
const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
const wsdlXml = fs.readFileSync(wsdlPath, 'utf8');
const serviceObject = qbwcServiceFactory();

const server = app.listen(PORT, () => {
  console.log(`[QBWC SOAP] Listening on http://localhost:${PORT}${BASE_PATH}`);
});

const soapServer = soap.listen(server, BASE_PATH, serviceObject, wsdlXml);

/* ===== Hooks de node-soap: soporta payload como OBJETO o como XML ===== */
function toPretty(any) {
  if (any == null) return '';
  if (typeof any === 'string') return any;
  try { return JSON.stringify(any, null, 2); } catch { return String(any); }
}

// Extrae user/pass de objeto o de XML
function extractCreds(payload) {
  let user = '', pass = '';

  // OBJETO
  if (payload && typeof payload === 'object') {
    const env = payload.Envelope || payload.envelope || payload;
    const body = env?.Body || env?.body || payload.Body || payload.body || payload;
    const auth = body?.authenticate || body?.Authenticate || payload.authenticate || payload.Authenticate;
    if (auth) {
      user = auth.strUserName || auth.userName || auth.UserName || '';
      pass = auth.strPassword || auth.password || auth.Password || '';
    }
  }

  // STRING (JSON o XML)
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

// REQUEST entrante
soapServer.on('request', (payload, methodName) => {
  try {
    ensureLogDir();
    const raw = toPretty(payload);
    fs.writeFileSync(fp('last-post-body.xml'), raw || '', 'utf8');

    const isAuth = (methodName || '').toLowerCase() === 'authenticate'
                || raw.includes('<authenticate')
                || raw.includes('"authenticate"');

    if (isAuth) {
      fs.writeFileSync(fp('last-auth-request.xml'), raw || '', 'utf8');

      const { user, pass } = extractCreds(payload);
      const envUser = process.env.WC_USERNAME || '';
      const envPass = process.env.WC_PASSWORD || '';

      console.log(`[QBWC] auth attempt user="${user}" matchUser=${user === envUser} passLen=${(pass || '').length}`);

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
    }
  } catch (e) {
    console.error('[SOAP hook:request] error:', e);
  }
});

// RESPONSE saliente
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
