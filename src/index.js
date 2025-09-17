'use strict';

const express = require('express');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { buildInventoryQueryXML } = require('./services/inventory');
const { buildInventoryAdjustmentXML } = require('./services/qbd.adjustment');
const { readJobs, enqueue, peekJob, popJob } = require('./services/jobQueue');
const { parseInventoryFromQBXML } = require('./services/inventoryParser');
require('dotenv').config();

/* ===== Config ===== */
const PORT      = process.env.PORT || 8080;             // En Azure Linux escucha 8080
const BASE_PATH = process.env.BASE_PATH || '/qbwc';
const LOG_DIR   = process.env.LOG_DIR || '/tmp';
const TNS       = 'http://developer.intuit.com/';
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

/* Generar QBXML según el job */
function qbxmlFor(job) {
  if (!job || !job.type) return '';

  if (job.type === 'inventoryQuery') {
    // Usamos el builder del servicio (desacople suave)
    const hasExplicitMax =
      Object.prototype.hasOwnProperty.call(job, 'max') && job.respectMax === true;
    const requestedMax = hasExplicitMax ? Number(job.max) : NaN;
    const max = Number.isFinite(requestedMax) && requestedMax > 0 ? Math.floor(requestedMax) : 0;
    return buildInventoryQueryXML(max, process.env.QBXML_VER || '13.0');
  }

   if (job.type === 'inventoryAdjust') {
    const ver = process.env.QBXML_VER || '16.0';
    return buildInventoryAdjustmentXML(job.lines || [], job.account, ver);
  }

  // Mantén aquí tus otros tipos de job si los tienes
  return '';
}


/* Parseo simple del ItemInventoryRet (sin libs) */
function parseInventorySnapshot(qbxml){
  try {
    const parsed = parseInventoryFromQBXML(qbxml) || {};
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch (e) {
    console.error('Inventory parse error:', e);
    return [];
  }
}

function shouldAutoPush(){
  const raw = process.env.SHOPIFY_AUTO_PUSH;
  if (raw == null || raw === '') return true;
  return /^(1|true|yes)$/i.test(String(raw).trim());
}

function getTodayRange(now = new Date()){
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function parseQBDate(value){
  if (!value) return null;
  const dt = new Date(value);
  return Number.isNaN(dt.valueOf()) ? null : dt;
}

function pickRelevantTimestamp(item){
  return item?.TimeModified || item?.TimeCreated || null;
}

function filterInventoryForToday(items, now = new Date()){
  const { start, end } = getTodayRange(now);
  const filtered = (items || []).filter((item) => {
    const stamp = parseQBDate(pickRelevantTimestamp(item));
    return stamp && stamp >= start && stamp < end;
  });
  return { filtered, start, end };
}

/* ===== App ===== */
const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

app.use('/debug', require('./routes/debug.inventory'));
app.use('/shopify', require('./routes/shopify.webhooks'));
app.use('/sync', require('./routes/sync.qbd-to-shopify'));
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

app.get('/qbwc', (req, res) => {
  res.status(200).type('text/plain').send('QBWC endpoint OK');
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

        // justo después de calcular ok=true en authenticate:
        if (ok && process.env.AUTO_SEED_ON_AUTH === 'true') {
          enqueue({ type: 'inventoryQuery', ts: new Date().toISOString() });
        }
        if (process.env.AUTO_ENQUEUE_INVENTORY_QUERY === 'true') {
          enqueue({ type: 'inventoryQuery', ts: new Date().toISOString() });
        }



        const passSha = crypto.createHash('sha256').update(pass||'', 'utf8').digest('hex');
        const envSha  = crypto.createHash('sha256').update(envPass, 'utf8').digest('hex');
        save('last-auth-cred.json', JSON.stringify({
          ts:new Date().toISOString(),
          receivedUser:user, receivedPassLen:(pass||'').length, receivedPassSha256:passSha,
          envUser, envPassLen:envPass.length, envPassSha256:envSha,
          matchUser:user===envUser, matchPassHash:passSha===envSha
        },null,2));

        // Ticket para esta sesión
        const ticket = ok
          ? (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'))
          : '';

        // ⬇️ Archivo de compañía:
        //  - Si WC_COMPANY_FILE está vacío / no definido ⇒ ''  (usar el archivo YA ABIERTO en QuickBooks)
        //  - Si prefieres forzar ruta, define WC_COMPANY_FILE con la ruta EXACTA en la VM.
        let companyFile = '';
        if (ok) {
          const envPath = (process.env.WC_COMPANY_FILE || '').trim();
          companyFile = envPath; // dejar '' para usar el archivo abierto
        }
        console.log('authenticate companyFile =>', companyFile || '(use currently open company)');

        bodyXml =
          `<authenticateResponse xmlns="${TNS}">` +
            `<authenticateResult>` +
              `<string>${ticket}</string>` +
              `<string>${companyFile}</string>` +
            `</authenticateResult>` +
          `</authenticateResponse>`;

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
        // Solo si el job fue de inventario, persistimos snapshot y (opcional) auto-push
        if (current && current.type === 'inventoryQuery') {
          const parsedItems = parseInventorySnapshot(resp);
          const { filtered: todaysItems, start, end } = filterInventoryForToday(parsedItems);
          const snapshotPayload = {
            count: todaysItems.length,
            filteredAt: new Date().toISOString(),
            filter: {
              mode: 'TimeModifiedSameDay',
              timezoneOffsetMinutes: new Date().getTimezoneOffset(),
              start: start.toISOString(),
              endExclusive: end.toISOString(),
              sourceCount: parsedItems.length,
            },
            items: todaysItems,
          };

          save('last-inventory.json', JSON.stringify(snapshotPayload, null, 2));
          console.log('[inventory] snapshot filtered for today', {
            totalReceived: parsedItems.length,
            kept: todaysItems.length,
            start: start.toISOString(),
            end: end.toISOString(),
          });

          // --- Auto push a Shopify (después de persistir el snapshot) ---
          try {
            const m = resp.match(/<ItemInventoryQueryRs[^>]*statusCode="(\d+)"/i);
            const ok = !m || m[1] === '0';
            const auto = shouldAutoPush();

            if (auto && !ok) {
              console.warn('Auto-push skipped due to QuickBooks error status.');
            }

            if (auto && ok && todaysItems.length > 0) {
              const { apply } = require('./services/shopify.sync');
              setImmediate(() =>
                apply().catch(e => console.error('Shopify apply error:', e))
              );
            } else if (auto && todaysItems.length === 0) {
              console.log('Auto-push skipped: no inventory changes detected for today.');
            }
          } catch (e) {
            console.error('Auto-push init error:', e);
          }
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
      else if (is('connectionError')) {
        const hresult = extract(raw, 'hresult') || '';
        const message = extract(raw, 'message') || '';
        console.error('WC connectionError:', hresult, message);
        bodyXml = `<connectionErrorResponse xmlns="${TNS}"><connectionErrorResult>DONE</connectionErrorResult></connectionErrorResponse>`;
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