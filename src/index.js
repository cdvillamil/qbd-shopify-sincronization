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
const PORT = process.env.PORT || 8080;                 // Azure Linux suele usar 8080
const BASE_PATH = process.env.BASE_PATH || '/qbwc';
const TNS = 'http://developer.intuit.com/';
const LOG_DIR = process.env.LOG_DIR || '/tmp';         // Escribimos en /tmp

/* ====== Utils ====== */
function ensureLogDir() { try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {} }
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

/* ====== Health & Debug ====== */
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

/* ====== SOAP server (todo el flujo) ====== */
const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
const wsdlXml = fs.readFileSync(wsdlPath, 'utf8');
const serviceObject = qbwcServiceFactory();

const server = app.listen(PORT, () => {
  console.log(`[QBWC SOAP] Listening on http://localhost:${PORT}${BASE_PATH}`);
});

// Montamos node-soap (único dueño del path /qbwc)
const soapServer = soap.listen(server, BASE_PATH, serviceObject, wsdlXml);

/* ====== Hooks de node-soap: request/response ======
   - No interferimos con Express ni con el streaming
   - Guardamos request, response y credenciales del authenticate
==================================================== */

// Seguridad: convertir payload a string seguro
function safeToString(payload) {
  if (payload == null) return '';
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  if (typeof payload === 'string') return payload;
  try { return JSON.stringify(payload); } catch { return String(payload); }
}

// 1) Cada request SOAP que llega
soapServer.on('request', (xml /*string*/, methodName /*string*/) => {
  try {
    const body = safeToString(xml);
    // Guarda SIEMPRE el último body
    fs.writeFileSync(fp('last-post-body.xml'), body || '', 'utf8');

    // Si es authenticate, log detallado + credenciales
    if ((methodName || '').toLowerCase() === 'authenticate' || body.includes('<authenticate')) {
      fs.writeFileSync(fp('last-auth-request.xml'), body || '', 'utf8');

      const user = (body.match(/<\w*:strUserName>([^<]*)<\/\w*:strUserName>/) || [])[1] || '';
      const pass = (body.match(/<\w*:strPassword>([^<]*)<\/\w*:strPassword>/) || [])[1] || '';

      const envUser = process.env.WC_USERNAME || '';
      const envPass = process.env.WC_PASSWORD || '';

      console.log(`[QBWC] auth attempt user="${user}" matchUser=${user === envUser} passLen=${pass.length}`);

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
    }
  } catch (e) {
    console.error('[SOAP hook:request] error:', e);
  }
});

// 2) Cada response SOAP que sale
soapServer.on('response', (xml /*string*/, methodName /*string*/) => {
  try {
    const body = safeToString(xml);
    fs.writeFileSync(fp('qbwc-last-response.xml'), body || '', 'utf8');
    if ((methodName || '').toLowerCase() === 'authenticate' || body.includes('<authenticateResponse')) {
      fs.writeFileSync(fp('last-auth-response.xml'), body || '', 'utf8');
    }
  } catch (e) {
    console.error('[SOAP hook:response] error:', e);
  }
});
