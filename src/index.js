'use strict';

const express = require('express');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
require('dotenv').config();

/* ===== Config ===== */
const PORT      = process.env.PORT || 8080;             // En Azure Linux escucha 8080
const BASE_PATH = process.env.BASE_PATH || '/qbwc';
const LOG_DIR   = process.env.LOG_DIR || '/tmp';
const TNS       = 'http://developer.intuit.com/';
const JOBS_FILE = path.join(LOG_DIR, 'jobs.json');
const CUR_JOB   = path.join(LOG_DIR, 'current-job.json');

function ensureLogDir(){ try{ fs.mkdirSync(LOG_DIR,{recursive:true}); }catch{} }
function fp(n){ return path.join(LOG_DIR,n); }
function readText(f){ return fs.existsSync(f) ? fs.readFileSync(f,'utf8') : null; }
function save(name, txt){ ensureLogDir(); fs.writeFileSync(fp(name), txt??'', 'utf8'); }
function sendFileSmart(res, file){
  if(!fs.existsSync(file)) return res.status(404).send('not found');
  const s = fs.readFileSync(file,'utf8'); 
  const looksXml = s.trim().startsWith('<');
  const looksJson = s.trim().startsWith('{')||s.trim().startsWith('[');
  res.type(looksXml?'application/xml':looksJson?'application/json':'text/plain').send(s);
}
function extract(text, tag){
  const m = text.match(new RegExp(`<(?:\\w*:)?${tag}>([\\s\\S]*?)<\\/(?:\\w*:)?${tag}>`));
  return m ? m[1] : '';
}
function extractCredsFromXml(xml){
  const user = extract(xml, 'strUserName') || extract(xml, 'userName') || extract(xml, 'UserName');
  const pass = extract(xml, 'strPassword') || extract(xml, 'password') || extract(xml, 'Password');
  return { user, pass };
}
function envelope(body){
  return `<?xml version="1.0" encoding="utf-8"?>`+
         `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">`+
         `<soap:Body>${body}</soap:Body></soap:Envelope>`;
}

/* ===== Cola de trabajos (persistida en /tmp) ===== */
function readJobs(){
  try{ ensureLogDir(); return JSON.parse(readText(JOBS_FILE)||'[]'); }catch{ return []; }
}
function writeJobs(list){ ensureLogDir(); fs.writeFileSync(JOBS_FILE, JSON.stringify(list,null,2)); }
function enqueue(job){ const L = readJobs(); L.push(job); writeJobs(L); }
function peekJob(){ const L = readJobs(); return L[0] || null; }
function popJob(){ const L = readJobs(); const j = L.shift(); writeJobs(L); return j||null; }

/* Generar QBXML según el job */
function qbxmlFor(job){
  if (job.type === 'inventoryQuery'){
    const max = Number(job.max)||10;
    return `<?xml version="1.0"?><?qbxml version="16.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <ItemInventoryQueryRq requestID="1">
      <MaxReturned>${max}</MaxReturned>
    </ItemInventoryQueryRq>
  </QBXMLMsgsRq>
</QBXML>`;
  }
  return '';
}

/* Parseo simple del ItemInventoryRet (sin libs) */
function parseInventory(qbxml){
  const out = [];
  const blocks = qbxml.match(/<ItemInventoryRet[\s\S]*?<\/ItemInventoryRet>/g) || [];
  for (const b of blocks){
    const ListID = extract(b,'ListID');
    const FullName = extract(b,'FullName');
    const QuantityOnHand = Number(extract(b,'QuantityOnHand')||0);
    out.push({ ListID, FullName, QuantityOnHand });
  }
  return out;
}

/* ===== App ===== */
const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

/* Health & debug */
app.get('/healthz', (_req,res)=>res.json({ok:true}));
app.get('/debug/config', (_req,res)=>res.json({
  user:process.env.WC_USERNAME||null,
  passLen:(process.env.WC_PASSWORD||'').length,
  companyFile:process.env.WC_COMPANY_FILE||'none',
  basePath:BASE_PATH, logDir:LOG_DIR
}));
app.get('/debug/where', (_req,res)=>{
  try{
    ensureLogDir();
    const files = fs.readdirSync(LOG_DIR).map(n=>{
      const st=fs.statSync(fp(n)); return {name:n,size:st.size,mtime:st.mtime};
    });
    res.json({logDir:LOG_DIR, files});
  }catch(e){ res.status(500).send(String(e)); }
});

/* Endpoints de depuración existentes */
app.get('/debug/last-post-body', (req,res)=>sendFileSmart(res, fp('last-post-body.xml')));
app.get('/debug/last-auth-request', (req,res)=>sendFileSmart(res, fp('last-auth-request.xml')));
app.get('/debug/last-auth-response',(req,res)=>sendFileSmart(res, fp('last-auth-response.xml')));
app.get('/debug/last-auth-cred', (req,res)=>{
  const p=fp('last-auth-cred.json'); if(!fs.existsSync(p)) return res.status(404).send('no auth cred yet');
  res.type('application/json').send(fs.readFileSync(p,'utf8'));
});

/* Nueva cola: ver y sembrar */
app.get('/debug/queue', (_req,res)=>res.json(readJobs()));
app.get('/debug/seed-inventory', (req,res)=>{
  const max = Number(req.query.max)||25;
  enqueue({ type:'inventoryQuery', max, ts:new Date().toISOString() });
  res.json({ ok:true, queued:{ type:'inventoryQuery', max }});
});
app.get('/debug/inventory', (req,res)=>{
  sendFileSmart(res, fp('last-inventory.json'));
});

/* WSDL (acepta ?wsdl aunque venga sin valor) */
app.get(BASE_PATH, (req,res,next)=>{
  if (!('wsdl' in req.query)) return next();
  try{
    const wsdlPath = path.join(__dirname,'wsdl','qbwc.wsdl');
    const xml = fs.readFileSync(wsdlPath,'utf8');
    res.type('application/xml').send(xml);
  }catch(e){ res.status(500).send(String(e)); }
});

/* === Handler SOAP manual (todos los métodos mínimos) === */
app.post(BASE_PATH, (req,res)=>{
  let raw=''; req.setEncoding('utf8');
  req.on('data', c=>{ raw+=c; });
  req.on('end', ()=>{
    try{
      save('last-post-body.xml', raw);

      const is = (tag)=> raw.includes(`<${tag}`) || raw.includes(`<tns:${tag}`);

      let bodyXml = '';

      if (is('serverVersion')) {
        bodyXml = `<serverVersionResponse xmlns="${TNS}"><serverVersionResult>1.0.0-dev</serverVersionResult></serverVersionResponse>`;
      }
      else if (is('clientVersion')) {
        bodyXml = `<clientVersionResponse xmlns="${TNS}"><clientVersionResult></clientVersionResult></clientVersionResponse>`;
      }
      else if (is('authenticate')) {
        save('last-auth-request.xml', raw);
        const {user,pass} = extractCredsFromXml(raw);
        const envUser = process.env.WC_USERNAME || '';
        const envPass = process.env.WC_PASSWORD || '';
        const ok = (user===envUser && pass===envPass);

        const passSha = crypto.createHash('sha256').update(pass||'', 'utf8').digest('hex');
        const envSha  = crypto.createHash('sha256').update(envPass, 'utf8').digest('hex');
        save('last-auth-cred.json', JSON.stringify({
          ts:new Date().toISOString(),
          receivedUser:user, receivedPassLen:(pass||'').length, receivedPassSha256:passSha,
          envUser, envPassLen:envPass.length, envPassSha256:envSha,
          matchUser:user===envUser, matchPassHash:passSha===envSha
        },null,2));

        const ticket = ok ? (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')) : '';
        const second = ok ? (process.env.WC_COMPANY_FILE || 'none') : 'nvu'; // 'nvu' -> Not valid user
        bodyXml = `<authenticateResponse xmlns="${TNS}"><authenticateResult><string>${ticket}</string><string>${second}</string></authenticateResult></authenticateResponse>`;
        const envlp = envelope(bodyXml);
        save('last-auth-response.xml', envlp);
        res.type('text/xml').status(200).send(envlp);
        return;
      }
      else if (is('sendRequestXML')) {
        // ¿Hay trabajo en cola?
        let job = peekJob();
        if (job){
          // Guardamos como "current" y lo sacamos de la cola
          fs.writeFileSync(CUR_JOB, JSON.stringify(job));
          popJob();
          const qbxml = qbxmlFor(job);
          save('last-request-qbxml.xml', qbxml);
          bodyXml = `<sendRequestXMLResponse xmlns="${TNS}"><sendRequestXMLResult>${qbxml.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</sendRequestXMLResult></sendRequestXMLResponse>`;
        }else{
          // Cola vacía -> retornar cadena vacía
          bodyXml = `<sendRequestXMLResponse xmlns="${TNS}"><sendRequestXMLResult></sendRequestXMLResult></sendRequestXMLResponse>`;
        }
      }
      else if (is('receiveResponseXML')) {
        const resp = extract(raw, 'response');
        const now  = Date.now();
        save(`last-response-${now}.xml`, resp);
        save('last-response.xml', resp);

        // Leer job actual para decidir parseo
        let current = null;
        try{ current = JSON.parse(readText(CUR_JOB)||'null'); }catch{}
        if (current && current.type === 'inventoryQuery'){
          const items = parseInventory(resp);
          save('last-inventory.json', JSON.stringify({count:items.length, items}, null, 2));
        }
        // Limpio current job
        try{ fs.unlinkSync(CUR_JOB); }catch{}

        // 100 => terminado este ciclo
        bodyXml = `<receiveResponseXMLResponse xmlns="${TNS}"><receiveResponseXMLResult>100</receiveResponseXMLResult></receiveResponseXMLResponse>`;
      }
      else if (is('getLastError')) {
        bodyXml = `<getLastErrorResponse xmlns="${TNS}"><getLastErrorResult></getLastErrorResult></getLastErrorResponse>`;
      }
      else if (is('closeConnection')) {
        bodyXml = `<closeConnectionResponse xmlns="${TNS}"><closeConnectionResult>OK</closeConnectionResult></closeConnectionResponse>`;
      }
      else {
        const fault = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <soap:Fault>
      <faultcode>soap:Client</faultcode>
      <faultstring>Method not implemented in stub</faultstring>
    </soap:Fault>
  </soap:Body>
</soap:Envelope>`;
        res.type('text/xml').status(200).send(fault);
        return;
      }

      const envlp = envelope(bodyXml);
      res.type('text/xml').status(200).send(envlp);
    }catch(e){
      res.status(500).type('text/plain').send(String(e));
    }
  });
});

/* Start */
app.listen(PORT, ()=> console.log(`[QBWC] Listening http://localhost:${PORT}${BASE_PATH}`));