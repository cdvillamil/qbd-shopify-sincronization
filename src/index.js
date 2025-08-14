'use strict';
const express = require('express');
const soap = require('soap');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config();

const { qbwcServiceFactory } = require('./services/qbwcService');

const PORT = process.env.PORT || 3000;           // En Azure suele ser 8080
const BASE_PATH = process.env.BASE_PATH || '/qbwc';

const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

/* ---------- Log persistente a archivo para TODA request SOAP ---------- */
app.use(BASE_PATH, (req, res, next) => {
  try {
    fs.appendFileSync(
      '/home/LogFiles/qbwc.log',
      `${new Date().toISOString()} ${req.method} ${req.originalUrl}\n`
    );
  } catch (_) {}
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
  const looksXml = txt.trim().startsWith('<');
  res.type(looksXml ? 'application/xml' : 'text/plain').send(txt);
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

// Último XML que guardamos desde receiveResponseXML (tu servicio lo escribe en /tmp)
app.get('/debug/last-response', (req, res) => {
  try { sendFileSmart(res, '/tmp/qbwc-last-response.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

// Último authenticate REQUEST (guardado en /home/LogFiles)
app.get('/debug/last-auth-request', (req, res) => {
  try { sendFileSmart(res, '/home/LogFiles/last-auth-request.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

// Último authenticate RESPONSE (si tu versión lo emite)
app.get('/debug/last-auth-response', (req, res) => {
  try { sendFileSmart(res, '/home/LogFiles/last-auth-response.xml'); }
  catch (e) { res.status(500).send(String(e)); }
});

/* ---------------- SOAP server ---------------- */
const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
const wsdlXml = fs.readFileSync(wsdlPath, 'utf8');
const serviceObject = qbwcServiceFactory();

const server = app.listen(PORT, () => {
  console.log(`[QBWC SOAP] Listening on http://localhost:${PORT}${BASE_PATH}`);
});

// Guardar referencia del servidor SOAP
const soapServer = soap.listen(server, BASE_PATH, serviceObject, wsdlXml);

/* ---- Hook de logging del paquete "soap": aquí sí tenemos XML crudo ---- */
soapServer.log = (type, data) => {
  try {
    if (type === 'received') {
      const xml = toXmlString(data);
      if (xml.includes('<authenticate')) {
        fs.writeFileSync('/home/LogFiles/last-auth-request.xml', xml, 'utf8');
        console.log('[SOAP] authenticate REQUEST saved via log hook:', xml.length, 'bytes');
      }
    } else if (type === 'replied') {
      const xml = toXmlString(data);
      if (xml.includes('<authenticate')) {
        fs.writeFileSync('/home/LogFiles/last-auth-response.xml', xml, 'utf8');
        console.log('[SOAP] authenticate RESPONSE saved via log hook:', xml.length, 'bytes');
      }
    } else {
      // Logs informativos (reduce ruido si quieres)
      if (typeof data === 'string') {
        console.log(`[SOAP] ${type}`, data.substring(0, 120) + '…');
      } else {
        console.log(`[SOAP] ${type}`);
      }
    }
  } catch (e) {
    console.error('[SOAP log hook] error:', e);
  }
};

/* ---- Fallback: algunas versiones emiten 'request'/'response' como objeto ---- */
soapServer.on('request', (payload, methodName) => {
  if (methodName === 'authenticate') {
    try {
      const xml = toXmlString(payload);  // <- convierte objeto/buffer a string seguro
      fs.writeFileSync('/home/LogFiles/last-auth-request.xml', xml, 'utf8');
      console.log('[SOAP] authenticate REQUEST saved via event:', xml.length, 'bytes');
    } catch (e) {
      console.error('Failed to save last-auth-request:', e);
    }
  }
});

soapServer.on('response', (payload, methodName) => {
  if (methodName === 'authenticate') {
    try {
      const xml = toXmlString(payload);
      fs.writeFileSync('/home/LogFiles/last-auth-response.xml', xml, 'utf8');
      console.log('[SOAP] authenticate RESPONSE saved via event:', xml.length, 'bytes');
    } catch (e) {
      console.error('Failed to save last-auth-response:', e);
    }
  }
});
