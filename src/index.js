'use strict';
const express = require('express');
const soap = require('soap');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config();

const { qbwcServiceFactory } = require('./services/qbwcService');

const PORT = process.env.PORT || 3000;
const BASE_PATH = process.env.BASE_PATH || '/qbwc';

const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

app.use(BASE_PATH, (req, res, next) => {
  try {
    fs.appendFileSync(
      '/home/LogFiles/qbwc.log',
      `${new Date().toISOString()} ${req.method} ${req.originalUrl}\n`
    );
  } catch (_) {}
  next();
});

/* ---------------- Health & Debug ---------------- */

app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

app.get('/debug/config', (req, res) => {
  res.json({
    user: process.env.WC_USERNAME || null,
    passLen: (process.env.WC_PASSWORD || '').length,
    basePath: BASE_PATH
  });
});

// Último XML que guardamos desde receiveResponseXML (tu servicio lo escribe en /tmp)
app.get('/debug/last-response', (req, res) => {
  try {
    const p = '/tmp/qbwc-last-response.xml';
    if (!fs.existsSync(p)) return res.status(404).send('No response saved yet');
    res.type('application/xml').send(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// Último authenticate REQUEST (lo que envía WC/Postman)
app.get('/debug/last-auth-request', (req, res) => {
  try {
    const p = '/home/LogFiles/last-auth-request.xml';
    if (!fs.existsSync(p)) return res.status(404).send('no auth request yet');
    res.type('text/xml').send(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// (Opcional) authenticate RESPONSE (no todas las versiones lo emiten)
app.get('/debug/last-auth-response', (req, res) => {
  try {
    const p = '/home/LogFiles/last-auth-response.xml';
    if (!fs.existsSync(p)) return res.status(404).send('no auth response yet');
    res.type('text/xml').send(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    res.status(500).send(String(e));
  }
});

/* ---------------- SOAP server ---------------- */

const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
const wsdlXml = fs.readFileSync(wsdlPath, 'utf8');
const serviceObject = qbwcServiceFactory();

const server = app.listen(PORT, () => {
  const baseUrl = `http://localhost:${PORT}${BASE_PATH}`;
  console.log(`[QBWC SOAP] Listening on ${baseUrl}`);
});

// Helper: convierte payload (string/buffer/objeto) a string seguro antes de guardar
function toXmlString(payload) {
  if (payload == null) return '';
  if (Buffer.isBuffer(payload)) return payload.toString('utf8');
  if (typeof payload === 'string') return payload;
  try { return JSON.stringify(payload, null, 2); } catch { return String(payload); }
}

// Importante: guardar el objeto retornado por soap.listen
const soapServer = soap.listen(server, BASE_PATH, serviceObject, wsdlXml);

// (Opcional) silenciar algo de ruido
soapServer.log = (type, data) => {
  if (type === 'received' || type === 'replied') return;
  console.log(`[SOAP] ${type}`, (data && data.substring) ? data.substring(0, 120) + '…' : data);
};

// Guardar authenticate REQUEST (node-soap emite 'request')
soapServer.on('request', (payload, methodName) => {
  if (methodName === 'authenticate') {
    try {
      const xml = toXmlString(payload);
      fs.writeFileSync('/home/LogFiles/last-auth-request.xml', xml, 'utf8');
      console.log('[SOAP] authenticate REQUEST saved:', xml.length, 'bytes');
    } catch (e) {
      console.error('Failed to save last-auth-request:', e);
    }
  }
});

// (Opcional) Guardar authenticate RESPONSE (si tu versión lo emite)
soapServer.on('response', (payload, methodName) => {
  if (methodName === 'authenticate') {
    try {
      const xml = toXmlString(payload);
      fs.writeFileSync('/home/LogFiles/last-auth-response.xml', xml, 'utf8');
      console.log('[SOAP] authenticate RESPONSE saved:', xml.length, 'bytes');
    } catch (e) {
      console.error('Failed to save last-auth-response:', e);
    }
  }
});
