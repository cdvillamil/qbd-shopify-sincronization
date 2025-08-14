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

app.get('/debug/config', (req, res) => {
  res.json({
    user: process.env.WC_USERNAME || null,
    passLen: (process.env.WC_PASSWORD || '').length,
    basePath: BASE_PATH
  });
});

app.get('/debug/last-response', (req, res) => {
  try {
    const p = '/tmp/qbwc-last-response.xml';
    if (!fs.existsSync(p)) return res.status(404).send('No response saved yet');
    res.type('application/xml').send(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    res.status(500).send(String(e));
  }
});

app.get('/debug/last-auth-response', (req, res) => {
  try {
    const p = '/tmp/last-auth-response.xml';
    if (!fs.existsSync(p)) return res.status(404).send('no auth response yet');
    res.type('text/xml').send(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// ⬇️ NUEVO: ver el último authenticate REQUEST (XML que envía el cliente)
app.get('/debug/last-auth-request', (req, res) => {
  const p = '/tmp/last-auth-request.xml';
  if (!fs.existsSync(p)) return res.status(404).send('no auth request yet');
  res.type('text/xml').send(fs.readFileSync(p, 'utf8'));
});


const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
const wsdlXml = fs.readFileSync(wsdlPath, 'utf8');
const serviceObject = qbwcServiceFactory();

const server = app.listen(PORT, () => {
  const baseUrl = `http://localhost:${PORT}${BASE_PATH}`;
  console.log(`[QBWC SOAP] Listening on ${baseUrl}`);
});
// 👇 IMPORTANTE: guarda el objeto devuelto por soap.listen
const soapServer = soap.listen(server, BASE_PATH, serviceObject, wsdlXml);

// (opcional) reduce ruido en logs
soapServer.log = (type, data) => {
  if (type === 'received' || type === 'replied') return;
  console.log(`[SOAP] ${type}`, (data && data.substring) ? data.substring(0, 120) + '…' : data);
};

// ⬇️ Guarda el authenticate REQUEST (node-soap emite 'request')
soapServer.on('request', (xml, methodName) => {
  if (methodName === 'authenticate') {
    try {
      fs.writeFileSync('/tmp/last-auth-request.xml', xml, 'utf8');
      console.log('[SOAP] authenticate REQUEST length:', xml.length);
    } catch (e) {
      console.error('Failed to save last-auth-request:', e);
    }
  }
});

// ⬇️ Algunas versiones también emiten 'response' (no siempre)
soapServer.on('response', (xml, methodName) => {
  if (methodName === 'authenticate') {
    try {
      fs.writeFileSync('/tmp/last-auth-response.xml', xml, 'utf8');
      console.log('[SOAP] authenticate RESPONSE length:', xml.length);
    } catch (e) {
      console.error('Failed to save last-auth-response:', e);
    }
  }
});

