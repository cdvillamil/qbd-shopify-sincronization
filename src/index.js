// index.js
'use strict';

const express = require('express');
const soap = require('soap');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

/* =========================
   Configuración y utilidades
   ========================= */
const PORT = process.env.PORT || 3000;
const BASE_PATH = process.env.BASE_PATH || '/qbwc';
const LOG_DIR = '/tmp';
const WS_NAMESPACE = 'http://developer.intuit.com/';

const APP_USER = process.env.WC_USERNAME || '';
const APP_PASS = process.env.WC_PASSWORD || '';

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
}
function w(p, data, type = 'utf8') {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, data, type);
}
function r(p, type = 'utf8') {
  return fs.existsSync(p) ? fs.readFileSync(p, type) : null;
}
function sha256(s) {
  return crypto.createHash('sha256').update(s || '').digest('hex');
}

/* ================
   Cola de “jobs”
   ================ */
const JOBS_PATH = path.join(LOG_DIR, 'jobs.json');
function loadJobs() {
  try {
    const t = r(JOBS_PATH);
    return t ? JSON.parse(t) : [];
  } catch { return []; }
}
function saveJobs(arr) {
  w(JOBS_PATH, JSON.stringify(arr, null, 2));
}
function pushJob(job) {
  const all = loadJobs();
  all.push({ ...job, enqueuedAt: new Date().toISOString() });
  saveJobs(all);
}
function popJob() {
  const all = loadJobs();
  const j = all.shift();
  saveJobs(all);
  return j || null;
}

/* =========================
   Construcción de QBXML (3 tipos)
   ========================= */
function qbxmlFor(job) {
  if (!job) return '';
  if (job.type === 'inventoryQuery') {
    const max = Number(job.max) || 50;

    // Un solo QBXML con 3 queries:
    // - ItemInventoryQueryRq
    // - ItemInventoryAssemblyQueryRq
    // - ItemSitesQueryRq  (por sitio; si no hay Advanced Inventory, vendrá vacío)
    const qbxml = `<?xml version="1.0"?><?qbxml version="16.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <ItemInventoryQueryRq requestID="1">
      <MaxReturned>${max}</MaxReturned>
      <OwnerID>0</OwnerID>
    </ItemInventoryQueryRq>
    <ItemInventoryAssemblyQueryRq requestID="2">
      <MaxReturned>${max}</MaxReturned>
      <OwnerID>0</OwnerID>
    </ItemInventoryAssemblyQueryRq>
    <ItemSitesQueryRq requestID="3">
      <MaxReturned>${max}</MaxReturned>
      <OwnerID>0</OwnerID>
    </ItemSitesQueryRq>
  </QBXMLMsgsRq>
</QBXML>`;
    w(path.join(LOG_DIR, 'last-request-qbxml.xml'), qbxml);
    return qbxml;
  }
  return '';
}

/* =======================================
   Parseo de ItemInventory/Assembly/Sites
   ======================================= */
function extractOne(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
}
function matchBlocks(xml, tag) {
  return xml.match(new RegExp(`<${tag}[\\s\\S]*?</${tag}>`, 'gi')) || [];
}

function parseInventory(xml) {
  const out = [];

  // 1) Inventory items
  for (const b of matchBlocks(xml, 'ItemInventoryRet')) {
    out.push({
      Type: 'ItemInventoryRet',
      ListID: extractOne(b, 'ListID'),
      FullName: extractOne(b, 'FullName'),
      EditSequence: extractOne(b, 'EditSequence'),
      IsActive: extractOne(b, 'IsActive') === 'true',
      QuantityOnHand: Number(extractOne(b, 'QuantityOnHand') || 0),
      BarCodeValue: extractOne(b, 'BarCodeValue')
    });
  }

  // 2) Assemblies
  for (const b of matchBlocks(xml, 'ItemInventoryAssemblyRet')) {
    out.push({
      Type: 'ItemInventoryAssemblyRet',
      ListID: extractOne(b, 'ListID'),
      FullName: extractOne(b, 'FullName'),
      EditSequence: extractOne(b, 'EditSequence'),
      IsActive: extractOne(b, 'IsActive') === 'true',
      QuantityOnHand: Number(extractOne(b, 'QuantityOnHand') || 0)
    });
  }

  // 3) Sites por artículo (Advanced Inventory)
  //    Estructura típica:
  //    <ItemSitesRet>
  //      <ItemInventoryRef><ListID>...</ListID><FullName>...</FullName></ItemInventoryRef>
  //      <SiteRef><ListID>...</ListID><FullName>...</FullName></SiteRef>
  //      <QuantityOnHand>...</QuantityOnHand>
  //    </ItemSitesRet>
  for (const b of matchBlocks(xml, 'ItemSitesRet')) {
    // intento de ubicar ItemInventoryRef o ItemRef dentro
    const itemRefBlock =
      (b.match(/<ItemInventoryRef>[\s\S]*?<\/ItemInventoryRef>/i) || [null])[0] ||
      (b.match(/<ItemRef>[\s\S]*?<\/ItemRef>/i) || [null])[0] ||
      '';

    const siteRefBlock =
      (b.match(/<SiteRef>[\s\S]*?<\/SiteRef>/i) || [null])[0] || '';

    const itemListID = extractOne(itemRefBlock, 'ListID');
    const itemFullName = extractOne(itemRefBlock, 'FullName');
    const siteListID = extractOne(siteRefBlock, 'ListID');
    const siteFullName = extractOne(siteRefBlock, 'FullName');

    out.push({
      Type: 'ItemSitesRet',
      ItemListID: itemListID,
      ItemFullName: itemFullName,
      SiteListID: siteListID,
      SiteFullName: siteFullName,
      QuantityOnHand: Number(extractOne(b, 'QuantityOnHand') || 0)
    });
  }

  return out;
}

/* ==========================
   Servicio SOAP (puerto WSDL)
   ========================== */
const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
const wsdlXml = fs.readFileSync(wsdlPath, 'utf8');

const service = {
  QBWebConnectorSvc: {
    QBWebConnectorSvcSoap: {
      serverVersion(args, cb) {
        // devolver algo corto para evitar warnings
        cb(null, { serverVersionResult: '1.0.0-dev' });
      },
      clientVersion(args, cb) {
        // aceptar cualquier versión
        cb(null, { clientVersionResult: '' });
      },
      authenticate(args, cb) {
        try {
          // Guardar REQUEST crudo que vino por SOAP
          const reqXml = r(path.join(LOG_DIR, 'last-post-body.xml')) || '';
          w(path.join(LOG_DIR, 'last-auth-request.xml'), reqXml);

          const user = (args && args.strUserName) || '';
          const pass = (args && args.strPassword) || '';
          const matchUser = user === APP_USER;
          const matchPass = pass === APP_PASS;

          const cred = {
            ts: new Date().toISOString(),
            receivedUser: user,
            receivedPassLen: pass.length,
            receivedPassSha256: sha256(pass),
            envUser: APP_USER,
            envPassLen: APP_PASS.length,
            envPassSha256: sha256(APP_PASS),
            matchUser,
            matchPassHash: sha256(pass) === sha256(APP_PASS)
          };
          w(path.join(LOG_DIR, 'last-auth-cred.json'), JSON.stringify(cred, null, 2));

          if (!matchUser || !matchPass) {
            const res = { authenticateResult: ['', 'nvu'] }; // not valid user
            // Log de la respuesta SOAP generada por node-soap
            w(path.join(LOG_DIR, 'last-auth-response.xml'),
              `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"  xmlns:tns="${WS_NAMESPACE}"><soap:Body><tns:authenticateResponse><authenticateResult><string></string><string>nvu</string></authenticateResult></tns:authenticateResponse></soap:Body></soap:Envelope>`);
            return cb(null, res);
          }

          const ticket = crypto.randomUUID();
          // Company file: "" => usa el company file actualmente abierto
          const res = { authenticateResult: [ticket, ''] };
          w(path.join(LOG_DIR, 'last-auth-response.xml'),
            `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"  xmlns:tns="${WS_NAMESPACE}"><soap:Body><tns:authenticateResponse><authenticateResult><string>${ticket}</string><string>none</string></authenticateResult></tns:authenticateResponse></soap:Body></soap:Envelope>`);
          return cb(null, res);
        } catch (e) {
          return cb(e);
        }
      },
      sendRequestXML(args, cb /* wcTicket, HCPResponseXML, cfn, qbNationality, qbXMLMajorVers, qbXMLMinorVers */) {
        try {
          // Tomar un job de la cola
          const job = popJob();

          if (!job) {
            // No hay trabajo → devolver cadena vacía
            return cb(null, { sendRequestXMLResult: '' });
          }

          const xml = qbxmlFor(job);
          if (!xml) {
            // si algo raro, no enviar nada
            return cb(null, { sendRequestXMLResult: '' });
          }

          // Guardar el body que se envía a QB
          w(path.join(LOG_DIR, 'last-request-qbxml.xml'), xml);
          return cb(null, { sendRequestXMLResult: xml });
        } catch (e) {
          return cb(e);
        }
      },
      receiveResponseXML(args, cb /* ticket, response, hresult, message */) {
        try {
          const now = Date.now();
          const xml = args && args.response || '';
          w(path.join(LOG_DIR, `last-response-${now}.xml`), xml);
          w(path.join(LOG_DIR, 'last-response.xml'), xml);

          const items = parseInventory(xml);
          const outPath = path.join(LOG_DIR, 'last-inventory.json');
          w(outPath, JSON.stringify({ count: items.length, items }, null, 2));

          // 100 => no hay más trabajo
          return cb(null, { receiveResponseXMLResult: 100 });
        } catch (e) {
          w(path.join(LOG_DIR, 'last-error.txt'), String(e.stack || e));
          return cb(null, { receiveResponseXMLResult: 100 });
        }
      },
      getLastError(args, cb) {
        const err = r(path.join(LOG_DIR, 'last-error.txt')) || '';
        cb(null, { getLastErrorResult: err });
      },
      closeConnection(args, cb) {
        cb(null, { closeConnectionResult: 'OK' });
      }
    }
  }
};

/* ===========
   Express
   =========== */
const app = express();
app.use(express.text({ type: '*/*', limit: '5mb' })); // capturar body crudo para /qbwc

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Depuración: dónde y qué archivos hay en /tmp
app.get('/debug/where', (req, res) => {
  const files = (fs.readdirSync(LOG_DIR) || []).map(name => {
    const st = fs.statSync(path.join(LOG_DIR, name));
    return { name, size: st.size, mtime: st.mtime };
  });
  res.json({ logDir: LOG_DIR, files });
});

// Últimas credenciales recibidas por authenticate
app.get('/debug/last-auth-cred', (req, res) => {
  const t = r(path.join(LOG_DIR, 'last-auth-cred.json'));
  if (!t) return res.status(404).send('no auth cred yet');
  res.type('application/json').send(t);
});

// Último POST crudo que llegó al endpoint SOAP
app.get('/debug/last-post-body', (req, res) => {
  const t = r(path.join(LOG_DIR, 'last-post-body.xml'));
  if (!t) return res.status(404).send('not found');
  res.type('text/xml').send(t);
});

// Últimas respuestas/requests de authenticate
app.get('/debug/last-auth-response', (req, res) => {
  const t = r(path.join(LOG_DIR, 'last-auth-response.xml'));
  if (!t) return res.status(404).send('not found');
  res.type('application/xml').send(t);
});
app.get('/debug/last-auth-request', (req, res) => {
  const t = r(path.join(LOG_DIR, 'last-auth-request.xml'));
  if (!t) return res.status(404).send('not found');
  res.type('application/xml').send(t);
});

// Sembrar un “job” de inventario
app.get('/debug/seed-inventory', (req, res) => {
  const max = Number(req.query.max) || 50;
  pushJob({ type: 'inventoryQuery', max });
  res.json({ ok: true, queued: { type: 'inventoryQuery', max } });
});

// Leer el último inventario consolidado
app.get('/debug/inventory', (req, res) => {
  const t = r(path.join(LOG_DIR, 'last-inventory.json'));
  if (!t) return res.json({ count: 0, items: [] });
  res.type('application/json').send(t);
});

// Endpoint auxiliar para ver config
app.get('/debug/config', (req, res) => {
  res.json({
    basePath: BASE_PATH,
    user: APP_USER,
    passLen: APP_PASS.length
  });
});

/* ====================================================
   Montar SOAP SOBRE EL MISMO servidor HTTP de Express
   ==================================================== */
const server = app.listen(PORT, () => {
  console.log(`[APP] HTTP listo en :${PORT} - SOAP en ${BASE_PATH} (WSDL ${BASE_PATH}?wsdl)`);
});

// Conectar SOAP; node-soap toma el control de /qbwc
const soapServer = soap.listen(server, BASE_PATH, service, wsdlXml);

// Guardar body crudo de cada POST que llega a SOAP
soapServer.on('request', (xml /*, methodName */) => {
  try {
    w(path.join(LOG_DIR, 'last-post-body.xml'), xml);
  } catch (e) {}
});

// También registrar la respuesta de authenticate
soapServer.on('response', (xml, methodName) => {
  if (methodName === 'authenticate') {
    try {
      w(path.join(LOG_DIR, 'last-auth-response.xml'), xml);
    } catch (e) {}
  }
});
