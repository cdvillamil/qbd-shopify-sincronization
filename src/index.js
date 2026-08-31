'use strict';

const express = require('express');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const http    = require('http');
const https   = require('https');
const { buildInventoryQueryXML } = require('./services/inventory');
const { parseInventoryFromQBXML } = require('./services/inventoryParser');
const { buildInventoryAdjustmentXML } = require('./services/qbd.adjustment');
const { buildSalesReceiptXML } = require('./services/qbd.salesReceipt');
const { buildInvoiceXML } = require('./services/qbd.invoice');
const { buildCreditMemoXML } = require('./services/qbd.creditMemo');
const { buildItemInventoryModXML } = require('./services/qbd.itemMod');
const {
  readJobs,
  enqueueJob,
  peekJob,
  popJob,
  setCurrentJob,
  getCurrentJob,
  clearCurrentJob,
  LOG_DIR,
  DEBUG_DIR,
  ensureDir: ensureLogDir,
  pruneLogFiles,
} = require('./services/jobQueue');
const { recordWcSeen, startWcMonitor, wcStatus } = require('./services/wcMonitor');
require('dotenv').config();

/* ===== Config ===== */
const PORT      = process.env.PORT || 8080;             // En Azure Linux escucha 8080
const BASE_PATH = process.env.BASE_PATH || '/qbwc';
const LAST_ERROR_FILE = 'last-error.txt';
const TNS       = 'http://developer.intuit.com/';

const LAST_RESPONSE_KEEP = Math.max(1, Number(process.env.LAST_RESPONSE_KEEP || 200));
const LAST_RESPONSE_MAX_AGE_HOURS = Number(process.env.LAST_RESPONSE_MAX_AGE_HOURS || 24);
const LAST_RESPONSE_MAX_AGE_MS = LAST_RESPONSE_MAX_AGE_HOURS > 0
  ? LAST_RESPONSE_MAX_AGE_HOURS * 60 * 60 * 1000
  : 0;
const LAST_RESPONSE_PATTERN = /^last-response-\d+\.xml$/;

const runtimeState = {
  lastExternalRequestAt: 0,
};

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function startPeriodicHealthPing(state = runtimeState) {
  const rawEnabled = String(process.env.HEALTHZ_PING_ENABLED || '').trim().toLowerCase();
  const hasExplicitFlag = rawEnabled !== '';
  const enabled = hasExplicitFlag
    ? /^(1|true|yes)$/i.test(rawEnabled)
    : Boolean(process.env.WEBSITE_HOSTNAME);

  if (!enabled) {
    console.log('[healthz-ping] disabled (set HEALTHZ_PING_ENABLED=true to enable).');
    return;
  }

  const intervalMs = toPositiveInteger(process.env.HEALTHZ_PING_INTERVAL_MS, 5 * 60 * 1000);
  const timeoutMs = toPositiveInteger(process.env.HEALTHZ_PING_TIMEOUT_MS, 10 * 1000);
  const explicitUrl = String(process.env.HEALTHZ_PING_URL || '').trim();
  const derivedUrl = process.env.WEBSITE_HOSTNAME
    ? `https://${process.env.WEBSITE_HOSTNAME}/healthz`
    : `http://127.0.0.1:${PORT}/healthz`;
  const targetUrl = explicitUrl || derivedUrl;

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (err) {
    console.warn('[healthz-ping] invalid HEALTHZ_PING_URL, skipping periodic ping:', targetUrl);
    return;
  }

  const client = parsed.protocol === 'https:' ? https : http;
  const requestOptions = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port || undefined,
    path: `${parsed.pathname}${parsed.search}`,
    method: 'GET',
    timeout: timeoutMs,
    headers: { 'user-agent': 'qbd-shopify-healthz-ping/1.0' },
  };

  const pingOnce = () => {
    const idleMs = Date.now() - Number(state?.lastExternalRequestAt || 0);
    if (idleMs > 0 && idleMs < intervalMs) {
      return;
    }

    const req = client.request(requestOptions, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode >= 400) {
        console.warn('[healthz-ping] non-success status:', res.statusCode);
      } else if (/^(1|true|yes)$/i.test(String(process.env.HEALTHZ_PING_LOG_SUCCESS || '').trim())) {
        console.log('[healthz-ping] success status:', res.statusCode || 'unknown');
      }
    });

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => console.warn('[healthz-ping] failed:', err?.message || err));
    req.end();
  };

  console.log(`[healthz-ping] enabled; target=${targetUrl}; intervalMs=${intervalMs}; timeoutMs=${timeoutMs}`);
  pingOnce();
  setInterval(pingOnce, intervalMs);
}

function pruneLastResponses() {
  try {
    pruneLogFiles(LAST_RESPONSE_PATTERN, {
      keep: LAST_RESPONSE_KEEP,
      maxAgeMs: LAST_RESPONSE_MAX_AGE_MS,
      dir: DEBUG_DIR,
    });
  } catch (err) {
    if (process.env.DEBUG_LOG_RETENTION) {
      console.warn('[qbwc] pruneLastResponses error:', err?.message || err);
    }
  }
}

function fp(n){ return path.join(LOG_DIR,n); }
function fpd(n){ return path.join(DEBUG_DIR,n); }
function readText(f){ return fs.existsSync(f) ? fs.readFileSync(f,'utf8') : null; }
function save(name, txt){ ensureLogDir(); fs.writeFileSync(fp(name), txt??'', 'utf8'); }
// Dumps voluminosos / desechables (XML crudos). Van a DEBUG_DIR (por defecto /tmp).
function saveDebug(name, txt){ ensureLogDir(DEBUG_DIR); fs.writeFileSync(fpd(name), txt??'', 'utf8'); }
function readJsonSafe(name){
  const target = fp(name);
  try {
    const raw = readText(target);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.warn('[inventory] Failed to parse JSON', { name, error: err?.message || err });
  }

  const backupPath = `${target}.bak`;
  try {
    const backupRaw = readText(backupPath);
    if (backupRaw) {
      console.warn('[inventory] Using backup JSON due to parse failure', { name, backup: `${name}.bak` });
      return JSON.parse(backupRaw);
    }
  } catch (err) {
    console.warn('[inventory] Failed to parse backup JSON', { name: `${name}.bak`, error: err?.message || err });
  }

  return null;
}

function saveJsonAtomic(name, value, { backup = true } = {}){
  const target = fp(name);
  const tmpPath = `${target}.tmp`;
  const backupPath = `${target}.bak`;
  const payload = JSON.stringify(value ?? null, null, 2);

  ensureLogDir();

  if (backup) {
    try {
      if (fs.existsSync(target)) {
        fs.copyFileSync(target, backupPath);
      }
    } catch (err) {
      console.warn('[inventory] Failed to snapshot backup before write', { name, error: err?.message || err });
    }
  }

  fs.writeFileSync(tmpPath, payload, 'utf8');
  fs.renameSync(tmpPath, target);

  if (backup) {
    try {
      fs.copyFileSync(target, backupPath);
    } catch (err) {
      console.warn('[inventory] Failed to refresh JSON backup', { name, error: err?.message || err });
    }
  }
}
function xmlEscape(txt){
  if (txt == null) return '';
  return String(txt)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
function clearSaved(name){
  try {
    const p = fp(name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) {
    console.error('[qbwc] Failed clearing saved file', { name, error: e });
  }
}
function readLastError(){
  return readText(fp(LAST_ERROR_FILE)) || '';
}
function clearLastError(){
  clearSaved(LAST_ERROR_FILE);
}
function persistLastError(text){
  save(LAST_ERROR_FILE, text || '');
}
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

/* ===== Cola de trabajos (persistida en LOG_DIR) ===== */
async function enqueue(job){
  return enqueueJob(job);
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
    const ver = job.qbxmlVer || process.env.QBXML_VER || '16.0';
    return buildInventoryAdjustmentXML(job.lines || [], job.account, ver);
  }

  if (job.type === 'invoiceAdd') {
    const ver = job.qbxmlVer || process.env.QBXML_VER || '16.0';
    return buildInvoiceXML(job.payload || job, ver);
  }

  if (job.type === 'salesReceiptAdd') {
    const ver = job.qbxmlVer || process.env.QBXML_VER || '16.0';
    return buildSalesReceiptXML(job.payload || job, ver);
  }

  if (job.type === 'creditMemoAdd') {
    const ver = job.qbxmlVer || process.env.QBXML_VER || '16.0';
    return buildCreditMemoXML(job.payload || job, ver);
  }

  if (job.type === 'itemInventoryMod') {
    const ver = job.qbxmlVer || process.env.QBXML_VER || '16.0';
    return buildItemInventoryModXML(job.payload || job, ver);
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

/* ===== App ===== */
const app = express();
app.use(morgan(process.env.LOG_LEVEL || 'dev'));

app.use((req, _res, next) => {
  if (req.path !== '/healthz') {
    runtimeState.lastExternalRequestAt = Date.now();
  }
  next();
});

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
  basePath:BASE_PATH, logDir:LOG_DIR, debugDir:DEBUG_DIR
}));
app.get('/debug/where', (_req,res)=>{
  try{
    ensureLogDir();
    const listDir = (dir)=>{
      try {
        return fs.readdirSync(dir).map(n=>{
          const st=fs.statSync(path.join(dir,n)); return {name:n,size:st.size,mtime:st.mtime};
        });
      } catch { return []; }
    };
    const out = { logDir:LOG_DIR, files:listDir(LOG_DIR) };
    if (DEBUG_DIR !== LOG_DIR) { out.debugDir = DEBUG_DIR; out.debugFiles = listDir(DEBUG_DIR); }
    res.json(out);
  }catch(e){ res.status(500).send(String(e)); }
});

/* Endpoints de depuración existentes (dumps en DEBUG_DIR) */
app.get('/debug/last-post-body', (req,res)=>sendFileSmart(res, fpd('last-post-body.xml')));
app.get('/debug/last-auth-request', (req,res)=>sendFileSmart(res, fpd('last-auth-request.xml')));
app.get('/debug/last-auth-response',(req,res)=>sendFileSmart(res, fpd('last-auth-response.xml')));
app.get('/debug/last-auth-cred', (req,res)=>{
  const p=fpd('last-auth-cred.json'); if(!fs.existsSync(p)) return res.status(404).send('no auth cred yet');
  res.type('application/json').send(fs.readFileSync(p,'utf8'));
});
app.get('/debug/last-response', (req, res) => sendFileSmart(res, fpd('last-response.xml')));

/* Nueva cola: ver y sembrar */
app.get('/debug/queue', (_req,res)=>res.json(readJobs()));
app.get('/debug/seed-inventory', async (req,res)=>{
  const job = { type:'inventoryQuery', ts:new Date().toISOString() };
  const rawMax = req.query.max;
  if (rawMax != null) {
    const parsedMax = Number(rawMax);
    if (Number.isFinite(parsedMax) && parsedMax > 0) {
      job.max = Math.floor(parsedMax);
      job.respectMax = true;
    }
  }
  await enqueue(job);
  res.json({ ok:true, queued:job });
});
app.get('/debug/inventory', (req,res)=>{
  sendFileSmart(res, fp('last-inventory.json'));
});

/* Estado de la sincronización QBD -> Shopify (Fase 1/2) */
app.get('/debug/sync-state', (req,res)=>sendFileSmart(res, fp('shopify-sync-state.json')));
app.get('/debug/unmatched', (req,res)=>sendFileSmart(res, fp('shopify-unmatched.json')));
app.get('/debug/sync-health', (req,res)=>sendFileSmart(res, fp('shopify-sync-health.json')));
app.get('/debug/reconcile', (req,res)=>sendFileSmart(res, fp('shopify-reconcile.json')));
app.get('/debug/wc-status', (_req,res)=>res.json(wcStatus()));

// Reinicia la línea base: el próximo poll vuelve a sembrar (sin empujar).
app.post('/debug/sync-state/reset', (req,res)=>{
  try {
    require('./services/syncState').resetState();
    res.json({ ok:true, note:'sync-state borrado; el próximo inventoryQuery re-siembra sin empujar.' });
  } catch (e) { res.status(500).json({ error:String(e?.message||e) }); }
});

// Comparación en vivo QBD vs Shopify (presencia de SKU). Revela los NO_MATCH.
app.get('/debug/drift', async (req,res)=>{
  try {
    if (String(req.query.cached||'') === '1') return sendFileSmart(res, fp('shopify-drift.json'));
    const { computeDrift } = require('./services/shopify.sync');
    res.json(await computeDrift());
  } catch (e) { res.status(500).json({ error:String(e?.message||e) }); }
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
  req.on('end', async () => {
    try{
      saveDebug('last-post-body.xml', raw);

      const is = (tag)=> raw.includes(`<${tag}`) || raw.includes(`<tns:${tag}`);

      // Marca actividad del Web Connector (para el monitor de caídas).
      try {
        const wcMethod = ['authenticate','sendRequestXML','receiveResponseXML','getLastError','closeConnection','serverVersion','clientVersion','connectionError']
          .find((t) => is(t));
        if (wcMethod) recordWcSeen(wcMethod);
      } catch (_) { /* noop */ }

      let bodyXml = '';

      if (is('serverVersion')) {
        bodyXml = `<serverVersionResponse xmlns="${TNS}"><serverVersionResult>1.0.0-dev</serverVersionResult></serverVersionResponse>`;
      }
      else if (is('clientVersion')) {
        bodyXml = `<clientVersionResponse xmlns="${TNS}"><clientVersionResult></clientVersionResult></clientVersionResponse>`;
      }
      else if (is('authenticate')) {
        saveDebug('last-auth-request.xml', raw);
        const {user,pass} = extractCredsFromXml(raw);
        const envUser = process.env.WC_USERNAME || '';
        const envPass = process.env.WC_PASSWORD || '';
        const ok = (user===envUser && pass===envPass);

        // justo después de calcular ok=true en authenticate:
        if (ok && process.env.AUTO_SEED_ON_AUTH === 'true') {
          await enqueue({ type: 'inventoryQuery', ts: new Date().toISOString() });
        }
        if (process.env.AUTO_ENQUEUE_INVENTORY_QUERY === 'true') {
          await enqueue({ type: 'inventoryQuery', ts: new Date().toISOString() });
        }



        const passSha = crypto.createHash('sha256').update(pass||'', 'utf8').digest('hex');
        const envSha  = crypto.createHash('sha256').update(envPass, 'utf8').digest('hex');
        saveDebug('last-auth-cred.json', JSON.stringify({
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
        saveDebug('last-auth-response.xml', envlp);
        res.type('text/xml').status(200).send(envlp);
        return;

      }
      else if (is('sendRequestXML')) {
        // ¿Hay trabajo en cola?
        let job = peekJob();
        let qbxml = '';
        while (job) {
          qbxml = qbxmlFor(job);
          if (qbxml) break;
          await popJob();
          job = peekJob();
        }

        if (job && qbxml) {
          setCurrentJob(job);
          await popJob();
          saveDebug('last-request-qbxml.xml', qbxml);
          console.log('[qbwc] sendRequestXML QBXML payload:', qbxml);
          bodyXml = `<sendRequestXMLResponse xmlns="${TNS}"><sendRequestXMLResult>${qbxml.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</sendRequestXMLResult></sendRequestXMLResponse>`;
        } else {
          // Cola vacía -> retornar cadena vacía
          clearCurrentJob();
          bodyXml = `<sendRequestXMLResponse xmlns="${TNS}"><sendRequestXMLResult></sendRequestXMLResult></sendRequestXMLResponse>`;
        }
      }
      else if (is('receiveResponseXML')) {
        const resp = extract(raw, 'response');
        const now  = Date.now();
        saveDebug(`last-response-${now}.xml`, resp);
        saveDebug('last-response.xml', resp);
        // Limpia snapshots antiguos en cada corrida del Web Connector
        pruneLastResponses();
        //console.log('[qbwc] receiveResponseXML QBXML payload:', resp);

        const hresult = (extract(raw, 'hresult') || '').trim();
        const message = (extract(raw, 'message') || '').trim();
        const statusErrors = [];
        const statusRegex = /<(ItemInventory\w*Rs)\b[^>]*statusCode="([^"\\s]+)"[^>]*>/gi;
        let statusMatch;
        while ((statusMatch = statusRegex.exec(resp))) {
          const [, tagName, codeRaw] = statusMatch;
          if (codeRaw && codeRaw !== '0') {
            const statusMessageMatch = statusMatch[0].match(/statusMessage="([^"]*)"/i);
            statusErrors.push({
              node: tagName,
              code: codeRaw,
              message: statusMessageMatch ? statusMessageMatch[1] : '',
            });
          }
        }

        const errorFragments = [];
        if (hresult && hresult !== '0') errorFragments.push(`HRESULT: ${hresult}`);
        if (message) errorFragments.push(`Message: ${message}`);
        statusErrors.forEach((err) => {
          const part = [`${err.node} statusCode=${err.code}`];
          if (err.message) part.push(`statusMessage="${err.message}"`);
          errorFragments.push(part.join(' '));
        });

        // Leer job actual para decidir parseo
        const current = getCurrentJob();
        // Solo si el job fue de inventario, persistimos snapshot y (opcional) auto-push
        if (current && current.type === 'inventoryQuery') {
          const parsedItems = parseInventorySnapshot(resp);

          // Reconciliación por diferencia (reemplaza el filtro "modificado hoy").
          // La primera corrida con estado vacío SOLO siembra la línea base; no empuja nada.
          let selection = { toSync: [], reason: 'error', stateSize: null, catalogSize: parsedItems.length, capped: false };
          try {
            const { selectItemsToSync } = require('./services/syncState');
            selection = selectItemsToSync(parsedItems);
          } catch (err) {
            console.error('[inventory] selectItemsToSync failed:', err);
          }

          const toSync = Array.isArray(selection.toSync) ? selection.toSync : [];
          const snapshotPayload = {
            count: toSync.length,
            filteredAt: new Date().toISOString(),
            filter: {
              mode: 'StateDiff',
              reason: selection.reason || null,
              catalogSize: parsedItems.length,
              stateSize: selection.stateSize ?? null,
              capped: Boolean(selection.capped),
            },
            items: toSync,
            allItems: parsedItems,
          };

          saveJsonAtomic('last-inventory.json', snapshotPayload);
          console.log('[inventory] snapshot saved', {
            catalog: parsedItems.length,
            toSync: toSync.length,
            reason: selection.reason,
            capped: Boolean(selection.capped),
          });

          // Reconciliación completa QBD vs Shopify (throttled por intervalo).
          try {
            const { runReconcileIfDue } = require('./services/shopify.sync');
            setImmediate(() => runReconcileIfDue().catch((err) => {
              console.error('Reconcile auto-run error:', err);
            }));
          } catch (err) {
            console.error('Reconcile trigger setup failed:', err);
          }

          // --- Auto push a Shopify (después de persistir el snapshot) ---
          try {
            const m = resp.match(/<ItemInventoryQueryRs[^>]*statusCode="(\d+)"/i);
            const ok = !m || m[1] === '0';
            const auto = shouldAutoPush();

            if (auto && !ok) {
              console.warn('Auto-push skipped due to QuickBooks error status.');
            } else if (auto && ok && toSync.length > 0) {
              const { apply, isSyncLocked, LOCK_ERROR_CODE } = require('./services/shopify.sync');
              if (isSyncLocked()) {
                console.log('Auto-push skipped: Shopify sync already running.');
              } else {
                setImmediate(() =>
                  apply().catch((e) => {
                    if (e && e.code === LOCK_ERROR_CODE) {
                      console.log('Shopify auto-push skipped: sync already in progress.');
                    } else {
                      console.error('Shopify apply error:', e);
                    }
                  })
                );
              }
            } else if (auto && toSync.length === 0) {
              console.log(`Auto-push skipped: no differences to sync (reason=${selection.reason}).`);
            }
          } catch (e) {
            console.error('Auto-push init error:', e);
          }
        }
        // Limpio current job
        clearCurrentJob();

        // Si aún hay trabajos en cola, indica que no hemos terminado para forzar otro ciclo
        const hasMoreJobs = !!peekJob();
        let percentDone = hasMoreJobs ? 0 : 100;

        if (errorFragments.length > 0) {
          percentDone = -101;
          const errorText = errorFragments.join('\n');
          persistLastError(errorText);
          console.error('[qbwc] receiveResponseXML detected error', {
            hresult: hresult || null,
            message: message || null,
            statusErrors,
            responseSnippet: resp ? resp.slice(0, 500) : null,
            persistedErrorText: errorText,
            percentDone,
          });
        } else {
          if (!hasMoreJobs) {
            if (readLastError()) {
              console.log('[qbwc] receiveResponseXML completed without errors, clearing last error state.');
            }
            clearLastError();
          }
          console.log('[qbwc] receiveResponseXML progress', { percentDone });
        }

        bodyXml = `<receiveResponseXMLResponse xmlns="${TNS}"><receiveResponseXMLResult>${percentDone}</receiveResponseXMLResult></receiveResponseXMLResponse>`;
      }
      else if (is('getLastError')) {
        const lastError = readLastError().trim();
        if (lastError) {
          console.error('[qbwc] getLastError returning persisted message:', lastError);
        } else {
          console.log('[qbwc] getLastError requested, no error recorded.');
        }
        bodyXml = `<getLastErrorResponse xmlns="${TNS}"><getLastErrorResult>${xmlEscape(lastError)}</getLastErrorResult></getLastErrorResponse>`;
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
app.listen(PORT, () => {
  startPeriodicHealthPing();
  startWcMonitor();
  console.log(`[QBWC] Listening http://localhost:${PORT}${BASE_PATH}`);
});
