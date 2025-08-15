'use strict';

const express = require('express');
const soap = require('soap');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { qbwcServiceFactory } = require('./services/qbwcService');

const PORT = process.env.PORT || 3000;        // En Azure suele ser 8080
const BASE_PATH = process.env.BASE_PATH || '/qbwc';

const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

/* ---------------- Log persistente de TODA request SOAP ---------------- */
app.use(BASE_PATH, (req, res, next) => {
  try {
    fs.appendFileSync(
      '/home/LogFiles/qbwc.log',
      `${new Date().toISOString()} ${req.method} ${req.originalUrl}\n`
    );
  } catch {}
  next();
});

/* ---------------- TAP de respuesta (captura el body real) ------------- */
app.use((req, res, next) => {
  if (!req.originalUrl.startsWith(BASE_PATH)) return next();

  const _write = res.write;
  const _end = res.end;
  const chunks = [];

  res.write = function (chunk, ...args) {
    if (chunk) chunks.push(Buffer.from(chunk));
    return _write.call(this, chunk, ...args);
  };

  res.end = function (chunk, ...args) {
    try {
      if (chunk) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');

      // Siempre guardamos el ÚLTIMO body POST crudo a /qbwc
      if (req.method === 'POST') {
        fs.writeFileSync('/home/LogFiles/last-post-body.xml', body || '', 'utf8');
        console.log('[DEBUG] saved last-post-body.xml:', (body || '').length, 'bytes');

        // Y si es authenticateResponse, además lo guardamos ahí
        if (body.includes('<authenticateResponse')) {
          fs.writeFileSync('/home/LogFiles/last-auth-response.xml', body, 'utf8');
          console.log('[DEBUG] saved last-auth-response.xml:', body.length, 'bytes');
        }
      }
    } catch (e) {
      console.error('[DEBUG] tap response error:', e);
    }
    return _end.call(this, chunk, ...args);
  };

  next();
});

/* ---------------- Helpers ---------------- */
function toXmlString(payload) {
  if (payload == null) return '';
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  if (typeof payload === 'string') return payload;
  try { return JSON.stringify(payload, null, 2); } catch { return String(payload); }
}
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

// Último QBXML recibido de QB
app.get('/debug/last-response', (req, res) => {
  try { sendFileSmart(res, '/tmp/qbwc-last-response.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

// Último authenticate REQUEST (XML del cliente)
app.get('/debug/last-auth-request', (req, res) => {
  try { sendFileSmart(res, '/home/LogFiles/last-auth-request.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

// Último authenticate RESPONSE (sobre SOAP real)
app.get('/debug/last-auth-response', (req, res) => {
  try { sendFileSmart(res, '/home/LogFiles/last-auth-response.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

// Último body POST crudo a /qbwc (sea el método que sea)
app.get('/debug/last-post-body', (req, res) => {
  try { sendFileSmart(res, '/home/LogFiles/last-post-body.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

/* ---------------- SOAP server ---------------- */
const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
const wsdlXml = fs.readFileSync(wsdlPath, 'utf8');
const serviceObject = qbwcServiceFactory();

const server = app.listen(PORT, () => {
  console.log(`[QBWC SOAP] Listening on http://localhost:${PORT}${BASE_PATH}`);
});

// Instancia de SOAP
const soapServer = soap.listen(server, BASE_PATH, serviceObject, wsdlXml);

/* ---- Hook del paquete "soap": capturamos el REQUEST de authenticate ---- */
soapServer.log = (type, data) => {
  try {
    if (type === 'received') {
      const xml = toXmlString(data);
      if (xml.includes('<authenticate')) {
        fs.writeFileSync('/home/LogFiles/last-auth-request.xml', xml, 'utf8');
        console.log('[SOAP] authenticate REQUEST saved:', xml.length, 'bytes');
      }
    } else if (type !== 'replied') {
      // reduce ruido
      if (typeof data === 'string') {
        console.log(`[SOAP] ${type}`, data.substring(0, 120) + '…');
      } else {
        console.log(`[SOAP] ${type}`);
      }
    }
  } catch (e) {
    console.error('[SOAP log hook] error:', e);
  }
});
