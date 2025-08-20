'use strict';

const express = require('express');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

/* ===== Config ===== */
const PORT = process.env.PORT || 8080;             // Azure Linux usa 8080
const BASE_PATH = process.env.BASE_PATH || '/qbwc';
const LOG_DIR = process.env.LOG_DIR || '/tmp';     // Escribible en App Service Linux
const TNS = 'http://developer.intuit.com/';

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
function toPretty(any) {
  if (any == null) return '';
  if (typeof any === 'string') return any;
  try { return JSON.stringify(any, null, 2); } catch { return String(any); }
}
function extractCredsFromXml(xml) {
  const u = xml.match(/<(?:\w*:)?(?:strUserName|userName|UserName)>([^<]*)<\/(?:\w*:)?(?:strUserName|userName|UserName)>/);
  const p = xml.match(/<(?:\w*:)?(?:strPassword|password|Password)>([^<]*)<\/(?:\w*:)?(?:strPassword|password|Password)>/);
  return { user: (u && u[1]) || '', pass: (p && p[1]) || '' };
}
ensureLogDir();

/* ===== App ===== */
const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

/* -------- Health & Debug -------- */
app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

app.get('/debug/config', (_req, res) => {
  res.json({
    user: process.env.WC_USERNAME || null,
    passLen: (process.env.WC_PASSWORD || '').length,
    companyFile: process.env.WC_COMPANY_FILE || null,
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

/* -------- WSDL (estático) --------
   Sirve /qbwc?wsdl desde el archivo local wsdl/qbwc.wsdl
   (Asegúrate de tener el wsdl correcto en esa ruta)
*/
app.get(BASE_PATH, (req, res, next) => {
  if ((req.query.wsdl || '').toString().length === 0) return next();
  try {
    const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
    const xml = fs.readFileSync(wsdlPath, 'utf8');
    res.type('application/xml').send(xml);
  } catch (e) { res.status(500).send(String(e)); }
});

/* -------- AUTHENTICATE STUB (MANUAL) --------
   Manejamos el POST completo y respondemos exactamente como QuickBooks espera:
   <authenticateResponse xmlns="http://developer.intuit.com/">
     <authenticateResult>
       <string>ticket</string>
       <string>none | C:\ruta\archivo.qbw | nvu</string>
     </authenticateResult>
   </authenticateResponse>
*/
app.post(BASE_PATH, (req, res) => {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    try {
      ensureLogDir();
      fs.writeFileSync(fp('last-post-body.xml'), raw || '', 'utf8');

      // ¿Es authenticate?
      const looksAuth = raw.includes('<authenticate') || raw.includes('authenticateRequest') || raw.includes('strUserName');
      if (!looksAuth) {
        // Si no es authenticate aún, puedes devolver SOAP Fault simple
        // o 501. Para validar conexión, con esto basta.
        const fault = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Client</faultcode>
      <faultstring>Only authenticate implemented in stub</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;
        res.type('text/xml').status(200).send(fault);
        return;
      }

      // Guardamos request específico
      fs.writeFileSync(fp('last-auth-request.xml'), raw || '', 'utf8');

      // Credenciales recibidas
      const { user, pass } = extractCredsFromXml(raw);

      // Comprobación con variables de entorno
      const envUser = process.env.WC_USERNAME || '';
      const envPass = process.env.WC_PASSWORD || '';
      const ok = (user === envUser && pass === envPass);

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
      console.log(`[QBWC] auth attempt user="${user}" ok=${ok}`);

      // ticket + segunda cadena
      const ticket = ok
        ? (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'))
        : '';

      // Si QuickBooks Desktop NO está abierto, la segunda cadena debería ser
      // la ruta absoluta del archivo .QBW. Si está abierto, "none" vale.
      const companyFile = ok
        ? (process.env.WC_COMPANY_FILE && process.env.WC_COMPANY_FILE.trim()
            ? process.env.WC_COMPANY_FILE.trim()
            : 'none')
        : 'nvu'; // not valid user

      const payload =
        `<string>${ticket}</string>` +
        `<string>${companyFile}</string>`;

      // Envelope con NAMESPACE POR DEFECTO (sin prefijos)
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
      res.status(200).send(envelope);
      fs.writeFileSync(fp('last-auth-response.xml'), envelope, 'utf8');
    } catch (e) {
      console.error('authenticate stub error:', e);
      res.status(500).type('text/plain').send(String(e));
    }
  });
});

/* ===== Arranque ===== */
app.listen(PORT, () => {
  console.log(`[QBWC AUTH-ONLY] Listening on http://localhost:${PORT}${BASE_PATH}`);
});
