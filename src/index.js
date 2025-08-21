// index.js
'use strict';

const express = require('express');
const soap    = require('soap');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
require('dotenv').config();

/* =========================
   Config & helpers
   ========================= */
const PORT      = process.env.PORT || 3000;
const BASE_PATH = process.env.BASE_PATH || '/qbwc';
const LOG_DIR   = process.env.LOG_DIR || '/tmp';
const TNS       = 'http://developer.intuit.com/';

const APP_USER  = process.env.WC_USERNAME || '';
const APP_PASS  = process.env.WC_PASSWORD || '';
const HAS_ADV   = (process.env.HAS_ADV_INV || '').toString() === '1';

const TRIGGER_FILE = path.join(LOG_DIR, 'seed-inventory.json');

function ensureDir(p){ try{ fs.mkdirSync(p,{recursive:true}); }catch{} }
function save(name, txt){ ensureDir(LOG_DIR); fs.writeFileSync(path.join(LOG_DIR, name), txt ?? '', 'utf8'); }
function read(name){ try{ return fs.readFileSync(path.join(LOG_DIR, name),'utf8'); } catch { return null; } }
function sha256(s){ return crypto.createHash('sha256').update(s||'').digest('hex'); }

/* =========================
   QBXML builder (3 tipos)
   ========================= */
function buildInventoryQBXML(max=200){
  const inv = `
    <ItemInventoryQueryRq requestID="1">
      <ActiveStatus>All</ActiveStatus>
      <OwnerID>0</OwnerID>
      <MaxReturned>${max}</MaxReturned>
    </ItemInventoryQueryRq>`;

  const asm = `
    <ItemInventoryAssemblyQueryRq requestID="2">
      <ActiveStatus>All</ActiveStatus>
      <OwnerID>0</OwnerID>
      <MaxReturned>${max}</MaxReturned>
    </ItemInventoryAssemblyQueryRq>`;

  const sites = HAS_ADV ? `
    <ItemSitesQueryRq requestID="3">
      <ActiveStatus>All</ActiveStatus>
      <OwnerID>0</OwnerID>
      <MaxReturned>${max}</MaxReturned>
    </ItemSitesQueryRq>` : '';

  const qbxml = `<?xml version="1.0"?><?qbxml version="16.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    ${inv}${asm}${sites}
  </QBXMLMsgsRq>
</QBXML>`;

  save('last-request-qbxml.xml', qbxml);
  return qbxml;
}

/* =========================
   Parser simple (sin libs)
   ========================= */
function blocks(xml, tag){ return xml.match(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'g')) || []; }
function val(block, tag){
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1] : '';
}

function parseInventory(qbxml){
  const out = [];

  // ItemInventoryRet
  for (const b of blocks(qbxml, 'ItemInventoryRet')){
    out.push({
      Type: 'ItemInventoryRet',
      ListID: val(b,'ListID'),
      FullName: val(b,'FullName') || val(b,'Name'),
      QuantityOnHand: Number(val(b,'QuantityOnHand') || 0),
      EditSequence: val(b,'EditSequence') || null
    });
  }

  // ItemInventoryAssemblyRet
  for (const b of blocks(qbxml, 'ItemInventoryAssemblyRet')){
    out.push({
      Type: 'ItemInventoryAssemblyRet',
      ListID: val(b,'ListID'),
      FullName: val(b,'FullName') || val(b,'Name'),
      QuantityOnHand: Number(val(b,'QuantityOnHand') || 0),
      EditSequence: val(b,'EditSequence') || null
    });
  }

  // ItemSitesRet (solo si existe; típico en Advanced Inventory)
  for (const b of blocks(qbxml, 'ItemSitesRet')){
    const itemRef = (b.match(/<ItemInventoryRef>[\\s\\S]*?<\\/ItemInventoryRef>/i)||[null])[0]
                 || (b.match(/<ItemRef>[\\s\\S]*?<\\/ItemRef>/i)||[null])[0] || '';
    const siteRef = (b.match(/<SiteRef>[\\s\\S]*?<\\/SiteRef>/i)||[null])[0] || '';
    out.push({
      Type: 'ItemSitesRet',
      ItemFullName: val(itemRef, 'FullName') || null,
      SiteFullName: val(siteRef, 'FullName') || null,
      QuantityOnHand: Number(val(b,'QuantityOnHand') || 0)
    });
  }

  return out;
}

/* =========================
   Express app (debug)
   ========================= */
const app = express();

app.get('/healthz', (req,res)=> res.json({ ok:true }));

app.get('/debug/where', (req,res)=>{
  ensureDir(LOG_DIR);
  const files = (fs.readdirSync(LOG_DIR) || []).map(name=>{
    const st = fs.statSync(path.join(LOG_DIR, name));
    return { name, size: st.size, mtime: st.mtime };
  });
  res.json({ logDir: LOG_DIR, files });
});

app.get('/debug/inventory', (req,res)=>{
  const t = read('last-inventory.json');
  if(!t) return res.json({ count:0, items:[] });
  res.type('application/json').send(t);
});

app.get('/debug/last-request-qbxml', (req,res)=>{
  const t = read('last-request-qbxml.xml');
  if(!t) return res.status(404).send('not found');
  res.type('application/xml').send(t);
});

app.get('/debug/last-response', (req,res)=>{
  const t = read('last-response.xml');
  if(!t) return res.status(404).send('not found');
  res.type('application/xml').send(t);
});

// Trigger manual para la próxima corrida del WC
app.get('/debug/seed-inventory', (req,res)=>{
  const max = Number(req.query.max) || 200;
  ensureDir(LOG_DIR);
  fs.writeFileSync(TRIGGER_FILE, JSON.stringify({ max, ts: new Date().toISOString() }, null, 2));
  res.json({ ok:true, trigger:{ max } });
});

// Debug auth/tráfico
app.get('/debug/last-auth-cred', (req,res)=>{
  const t = read('last-auth-cred.json');
  if(!t) return res.status(404).send('no auth cred yet');
  res.type('application/json').send(t);
});
app.get('/debug/last-auth-request', (req,res)=>{
  const t = read('last-auth-request.xml');
  if(!t) return res.status(404).send('not found');
  res.type('application/xml').send(t);
});
app.get('/debug/last-auth-response', (req,res)=>{
  const t = read('last-auth-response.xml');
  if(!t) return res.status(404).send('not found');
  res.type('application/xml').send(t);
});
app.get('/debug/last-post-body', (req,res)=>{
  const t = read('last-post-body.xml');
  if(!t) return res.status(404).send('not found');
  res.type('text/xml').send(t);
});

/* =========================
   SOAP service
   ========================= */
const wsdlPath = path.join(__dirname, 'wsdl', 'qbwc.wsdl');
const wsdlXml  = fs.readFileSync(wsdlPath, 'utf8');

const service = {
  QBWebConnectorSvc: {
    QBWebConnectorSvcSoap: {
      serverVersion(args, cb){
        cb(null, { serverVersionResult: '1.0.0-dev' });
      },
      clientVersion(args, cb){
        cb(null, { clientVersionResult: '' }); // acepta cualquier WC
      },
      authenticate(args, cb){
        const user = (args?.strUserName || '').trim();
        const pass = args?.strPassword || '';

        // auditar lo recibido
        save('last-auth-request.xml', JSON.stringify({ Body:{ authenticate:{ strUserName:user, strPassword:pass } } }, null, 2));
        save('last-auth-cred.json', JSON.stringify({
          ts: new Date().toISOString(),
          receivedUser: user,
          receivedPassLen: pass.length,
          receivedPassSha256: sha256(pass),
          envUser: APP_USER,
          envPassLen: APP_PASS.length,
          envPassSha256: sha256(APP_PASS),
          matchUser: user === APP_USER,
          matchPassHash: pass === APP_PASS
        }, null, 2));

        if (user !== APP_USER || pass !== APP_PASS){
          // not valid user
          save('last-auth-response.xml',
            `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${TNS}"><soap:Body><tns:authenticateResponse><authenticateResult><string></string><string>nvu</string></authenticateResult></tns:authenticateResponse></soap:Body></soap:Envelope>`);
          return cb(null, { authenticateResult: ['', 'nvu'] });
        }

        const ticket = crypto.randomUUID();
        // 'none' => usa el company file actualmente abierto
        save('last-auth-response.xml',
          `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${TNS}"><soap:Body><tns:authenticateResponse><authenticateResult><string>${ticket}</string><string>none</string></authenticateResult></tns:authenticateResponse></soap:Body></soap:Envelope>`);
        cb(null, { authenticateResult: [ticket, 'none'] });
      },
      sendRequestXML(args, cb){
        // ¿hay trigger?
        let cfg = null;
        try { cfg = JSON.parse(read('seed-inventory.json') || 'null'); } catch {}
        if (!cfg){
          // No hay trabajo -> cadena vacía (comportamiento “antiguo”)
          return cb(null, { sendRequestXMLResult: '' });
        }

        const max   = Number(cfg.max) || 200;
        const qbxml = buildInventoryQBXML(max);
        // Consumimos el trigger
        try { fs.unlinkSync(TRIGGER_FILE); } catch {}

        // Devolver QBXML sin escapar; node-soap se encarga del envelope
        return cb(null, { sendRequestXMLResult: qbxml });
      },
      receiveResponseXML(args, cb){
        const xml = args?.response || args?.responseXml || args?.strResponseXML || '';
        save(`last-response-${Date.now()}.xml`, xml);
        save('last-response.xml', xml);

        const items = parseInventory(xml);
        save('last-inventory.json', JSON.stringify({ count: items.length, items }, null, 2));

        // 100 => no hay más trabajo que hacer en este ciclo
        cb(null, { receiveResponseXMLResult: 100 });
      },
      getLastError(args, cb){
        // devolvemos vacío para no alarmar al WC
        cb(null, { getLastErrorResult: '' });
      },
      closeConnection(args, cb){
        cb(null, { closeConnectionResult: 'OK' });
      }
    }
  }
};

/* =========================
   HTTP + SOAP binding
   ========================= */
const appServer = app.listen(PORT, ()=>{
  console.log(`[APP] HTTP listo en :${PORT} | SOAP en ${BASE_PATH} (WSDL ${BASE_PATH}?wsdl)`);
});

// No añadimos body parsers que interfieran con node-soap
const soapServer = soap.listen(appServer, BASE_PATH, service, wsdlXml);

// Log del XML crudo que llega/sale del SOAP
soapServer.on('request', (xml /*, methodName*/)=>{
  save('last-post-body.xml', xml);
});
soapServer.on('response', (xml, methodName)=>{
  if (methodName === 'authenticate') {
    save('last-auth-response.xml', xml);
  }
});