'use strict';

const http    = require('http');
const express = require('express');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');
const soap    = require('soap');
const { readJobs, enqueue } = require('./services/jobQueue');
const { qbwcServiceFactory } = require('./services/qbwcService');
const { startAutoSync: startShopifyToQbdAutoSync } = require('./services/shopify.to.qbd');
require('dotenv').config();

/* ===== Config ===== */
const PORT      = process.env.PORT || 8080;             // En Azure Linux escucha 8080
const BASE_PATH = process.env.BASE_PATH || '/qbwc';
const LOG_DIR   = process.env.LOG_DIR || '/tmp';

function ensureLogDir(){ try{ fs.mkdirSync(LOG_DIR,{recursive:true}); }catch{} }
function fp(n){ return path.join(LOG_DIR,n); }
function save(name, txt){ ensureLogDir(); fs.writeFileSync(fp(name), txt??'', 'utf8'); }
function sendFileSmart(res, file){
  if(!fs.existsSync(file)) return res.status(404).send('not found');
  const s = fs.readFileSync(file,'utf8');
  const looksXml = s.trim().startsWith('<');
  const looksJson = s.trim().startsWith('{')||s.trim().startsWith('[');
  res.type(looksXml?'application/xml':looksJson?'application/json':'text/plain').send(s);
}
/* ===== App ===== */
const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

app.use('/debug', require('./routes/debug.inventory'));
app.use('/shopify', require('./routes/shopify.webhooks'));
app.use('/sync', require('./routes/sync.qbd-to-shopify'));
app.use('/sync', require('./routes/sync.shopify-to-qbd'));
app.use('/shopify', require('./routes/shopify.admin'));


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
app.get('/debug/last-response', (req, res) => sendFileSmart(res, fp('last-response.xml')));
app.get('/debug/last-soap-response', (req, res) => sendFileSmart(res, fp('last-soap-response.xml')));

/* Nueva cola: ver y sembrar */
app.get('/debug/queue', (_req,res)=>res.json(readJobs()));
app.get('/debug/seed-inventory', (req,res)=>{
  const job = { type:'inventoryQuery', ts:new Date().toISOString() };
  const rawMax = req.query.max;
  if (rawMax != null) {
    const parsedMax = Number(rawMax);
    if (Number.isFinite(parsedMax) && parsedMax > 0) {
      job.max = Math.floor(parsedMax);
      job.respectMax = true;
    }
  }
  enqueue(job);
  res.json({ ok:true, queued:job });
});
app.get('/debug/inventory', (req,res)=>{
  sendFileSmart(res, fp('last-inventory.json'));
});
/* Start */
const server = http.createServer(app);
server.listen(PORT, ()=> console.log(`[QBWC] Listening http://localhost:${PORT}${BASE_PATH}`));

try {
  const wsdlPath = path.join(__dirname,'wsdl','qbwc.wsdl');
  const wsdlXml = fs.readFileSync(wsdlPath,'utf8');
  const soapService = qbwcServiceFactory();
  const soapServer = soap.listen(server, BASE_PATH, soapService, wsdlXml);

  soapServer.on('request', (requestXml) => {
    try { save('last-post-body.xml', requestXml); }
    catch (err) { console.error('[soap] failed to save last request:', err); }
  });

  soapServer.on('response', (responseXml) => {
    try { save('last-soap-response.xml', responseXml); }
    catch (err) { console.error('[soap] failed to save last SOAP response:', err); }
  });
} catch (err) {
  console.error('[soap] init error:', err);
}

try {
  const auto = startShopifyToQbdAutoSync();
  if (auto?.enabled) {
    console.log('[shopify->qbd] auto sync enabled', auto);
  } else if (auto && !auto.enabled) {
    console.log('[shopify->qbd] auto sync disabled', auto.reason || 'disabled');
  }
} catch (err) {
  console.error('[shopify->qbd] auto sync init error:', err);
}

