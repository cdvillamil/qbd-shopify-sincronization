'use strict';

const express = require('express');
const soap = require('soap');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { qbwcServiceFactory } = require('./services/qbwcService');

const PORT = process.env.PORT || 3000;      // En Azure suele ser 8080
const BASE_PATH = process.env.BASE_PATH || '/qbwc';

const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

/* ---------- Log persistente de TODA request SOAP ---------- */
app.use(BASE_PATH, (req, res, next) => {
  try {
    fs.appendFileSync(
      '/home/LogFiles/qbwc.log',
      `${new Date().toISOString()} ${req.method} ${req.originalUrl}\n`
    );
  } catch (_) {}
  next();
});

/* ---------- TAP de respuesta: guarda el body real del POST ---------- */
app.use((req, res, next) => {
  if (!req.originalUrl.startsWith(BASE_PATH)) return next();

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const chunks = [];

  res.write = (chunk, ...args) => {
    try {
      if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } catch (_) {}
    return originalWrite(chunk, ...args);
  };

  res.end = (chunk, ...args) => {
    try {
      if (chunk != null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');

      if (req.method === 'POST') {
        // Guarda SIEMPRE el último body POST a /qbwc
        fs.writeFileSync('/home/LogFiles/last-post-body.xml', body || '', 'utf8');
        // Si es authenticateResponse, guarda aparte
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

/* ---------- Helpers ---------- */
function sendFileSmart(res, filePath) {
  if (!fs.existsSync(filePath)) return res.status(404).send('not found');
  const txt = fs.readFileSync(filePath, 'utf8');
  res.type(txt.trim().startsWith('<') ? 'application/xml' : 'text/plain').send(txt);
}

/* ---------- Health & Debug ---------- */
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

app.get('/debug/config', (_req, res) => {
  res.json({
    user: process.env.WC_USERNAME || null,
    passLen: (process.env.WC_PASSWORD || '').length,
    basePath: BASE_PATH
  });
});

// Último QBXML recibido de QB (lo guarda receiveResponseXML en /tmp)
app.get('/debug/last-response', (req, res) => {
  try { sendFileSmart(res, '/tmp/qbwc-last-response.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

// Último authenticate REQUEST (desde hook del paquete soap)
app.get('/debug/last-auth-request', (req, res) => {
  try { sendFileSmart(res, '/home/LogFiles/last-auth-request.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

// Último authenticate RESPONSE (sobre SOAP real del tap)
app.get('/debug/last-auth-response', (req, res) => {
  try { sendFileSmart(res, '/home/LogFiles/last-auth-response.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

// Último body POST crudo a /qbwc (sea el método que sea)
app.get('/debug/last-post-body', (req, res) => {
  try { sendFileSmart(res, '/home/LogFiles/last-post-body.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

/* ---------- SOAP server ---------- */
const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl'); // ojo a la ruta
const wsdlXml = fs.readFileSync(wsdlPath, 'utf8');
const serviceObject = qbwcServiceFactory();

const server = app.listen(PORT, () => {
  console.log(`[QBWC SOAP] Listening on http://localhost:${PORT}${BASE_PATH}`);
});

const soapServer = soap.listen(server, BASE_PATH, serviceObject, wsdlXml);

/* ---- Hook del paquete "soap": capturar authenticate REQUEST ---- */
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
