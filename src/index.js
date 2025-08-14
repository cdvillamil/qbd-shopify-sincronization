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

const server = app.listen(PORT, () => {
  console.log(`[QBWC SOAP] Listening on http://localhost:${PORT}${BASE_PATH}`);
});

const wsdlPath = path.join(__dirname, 'src', 'wsdl', 'qbwc.wsdl');
const wsdlXml = fs.readFileSync(wsdlPath, 'utf8');

const service = qbwcServiceFactory();

const soapServer = soap.listen(server, BASE_PATH, service, wsdlXml);

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
