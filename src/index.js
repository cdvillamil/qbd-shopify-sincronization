// src/index.js
'use strict';

const express = require('express');
const soap    = require('soap');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');
require('dotenv').config();

// Importa tu servicio (ahí está authenticate, sendRequestXML, receiveResponseXML, etc.)
const { qbwcServiceFactory } = require('./services/qbwcService');

// ---- Config básica
const PORT      = process.env.PORT || 3000;
const BASE_PATH = process.env.BASE_PATH || '/qbwc';
const LOG_DIR   = process.env.LOG_DIR || '/tmp';

function pJoin(name){ return path.join(LOG_DIR, name); }
function fileExists(p){ try { return fs.existsSync(p); } catch { return false; } }

// ---- App HTTP (sin body parsers globales)
const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

// Salud
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

// Config visible
app.get('/debug/config', (req, res) => {
  res.json({
    user: process.env.WC_USERNAME || null,
    passLen: (process.env.WC_PASSWORD || '').length,
    basePath: BASE_PATH,
    logDir: LOG_DIR
  });
});

// Dónde y qué archivos hay en /tmp
app.get('/debug/where', (req, res) => {
  try {
    if (!fs.existsSync(LOG_DIR)) return res.json({ logDir: LOG_DIR, files: [] });
    const files = fs.readdirSync(LOG_DIR).map(name => {
      const st = fs.statSync(pJoin(name));
      return { name, size: st.size, mtime: st.mtime };
    });
    res.json({ logDir: LOG_DIR, files });
  } catch (e) {
    res.status(500).send(String(e));
  }
});

// ---- Endpoints de inspección de archivos (creados por tu servicio)
app.get('/debug/last-post-body', (req, res) => {
  const p = pJoin('last-post-body.xml');
  if (!fileExists(p)) return res.status(404).send('not found');
  res.type('text/xml').send(fs.readFileSync(p, 'utf8'));
});

app.get('/debug/last-auth-request', (req, res) => {
  const p = pJoin('last-auth-request.xml');
  if (!fileExists(p)) return res.status(404).send('no auth request yet');
  // Puede ser JSON o XML según cómo lo guardes en el servicio
  const txt = fs.readFileSync(p, 'utf8');
  res.type(txt.trim().startsWith('{') ? 'application/json' : 'text/xml').send(txt);
});

app.get('/debug/last-auth-response', (req, res) => {
  const p = pJoin('last-auth-response.xml');
  if (!fileExists(p)) return res.status(404).send('not found');
  res.type('text/xml').send(fs.readFileSync(p, 'utf8'));
});

app.get('/debug/last-auth-cred', (req, res) => {
  const p = pJoin('last-auth-cred.json');
  if (!fileExists(p)) return res.status(404).send('no auth cred yet');
  res.type('application/json').send(fs.readFileSync(p, 'utf8'));
});

app.get('/debug/last-request-qbxml', (req, res) => {
  const p = pJoin('last-request-qbxml.xml');
  if (!fileExists(p)) return res.status(404).send('not found');
  res.type('application/xml').send(fs.readFileSync(p, 'utf8'));
});

app.get('/debug/last-response', (req, res) => {
  const p = pJoin('last-response.xml');
  if (!fileExists(p)) return res.status(404).send('not found');
  res.type('application/xml').send(fs.readFileSync(p, 'utf8'));
});

app.get('/debug/inventory', (req, res) => {
  const p = pJoin('last-inventory.json');
  if (!fileExists(p)) return res.json({ count: 0, items: [] });
  res.type('application/json').send(fs.readFileSync(p, 'utf8'));
});

// ---- Carga WSDL y arranca SOAP
const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
const wsdlXml  = fs.readFileSync(wsdlPath, 'utf8');
const serviceObject = qbwcServiceFactory();

const server = app.listen(PORT, () => {
  console.log(`[QBWC] HTTP listo en :${PORT} | SOAP en ${BASE_PATH} (WSDL ${BASE_PATH}?wsdl)`);
});

// Importante: no hay app.use(express.json()/text()) globales antes de esto.
const soapServer = soap.listen(server, BASE_PATH, serviceObject, wsdlXml);

// Hooks de logging de tráfico SOAP (seguros)
soapServer.on('request', (xml /*, methodName*/) => {
  try {
    const payload = (typeof xml === 'string') ? xml : (xml && xml.xml ? xml.xml : JSON.stringify(xml));
    fs.writeFileSync(pJoin('last-post-body.xml'), payload, 'utf8');
  } catch {}
});

soapServer.on('response', (xml, methodName) => {
  try {
    if (methodName === 'authenticate') {
      const payload = (typeof xml === 'string') ? xml : (xml && xml.body ? xml.body : JSON.stringify(xml));
      fs.writeFileSync(pJoin('last-auth-response.xml'), payload, 'utf8');
    }
  } catch {}
});