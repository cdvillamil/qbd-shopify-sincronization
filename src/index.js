'use strict';

const express = require('express');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
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
  ensureDir: ensureLogDir,
  pruneLogFiles,
} = require('./services/jobQueue');
require('dotenv').config();

/* ===== Config ===== */
const PORT      = process.env.PORT || 8080;             // En Azure Linux escucha 8080
const BASE_PATH = process.env.BASE_PATH || '/qbwc';
const LAST_ERROR_FILE = 'last-error.txt';
const TNS       = 'http://developer.intuit.com/';

const LAST_RESPONSE_KEEP = Math.max(1, Number(process.env.LAST_RESPONSE_KEEP || 1440));
const LAST_RESPONSE_MAX_AGE_HOURS = Number(process.env.LAST_RESPONSE_MAX_AGE_HOURS || 48);
const LAST_RESPONSE_MAX_AGE_MS = LAST_RESPONSE_MAX_AGE_HOURS > 0
  ? LAST_RESPONSE_MAX_AGE_HOURS * 60 * 60 * 1000
  : 0;
const LAST_RESPONSE_PATTERN = /^last-response-\d+\.xml$/;

function pruneLastResponses() {
  try {
    pruneLogFiles(LAST_RESPONSE_PATTERN, {
      keep: LAST_RESPONSE_KEEP,
      maxAgeMs: LAST_RESPONSE_MAX_AGE_MS,
    });
  } catch (err) {
    if (process.env.DEBUG_LOG_RETENTION) {
      console.warn('[qbwc] pruneLastResponses error:', err?.message || err);
    }
  }
}

const SKU_FIELD_PRIORITY = (process.env.QBD_SKU_FIELDS || process.env.QBD_SKU_FIELD || 'Name')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function fp(n){ return path.join(LOG_DIR,n); }
function readText(f){ return fs.existsSync(f) ? fs.readFileSync(f,'utf8') : null; }
function save(name, txt){ ensureLogDir(); fs.writeFileSync(fp(name), txt??'', 'utf8'); }
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

function pickListId(item){
  if (!item) return null;
  if (item.ListID != null) return String(item.ListID);
  if (item.ListId != null) return String(item.ListId);
  return null;
}

function pickSkuForSnapshot(item) {
  if (!item) return null;
  for (const field of SKU_FIELD_PRIORITY) {
    const raw = item[field];
    if (raw == null) continue;
    const value = String(raw).trim();
    if (value) return value.toUpperCase();
  }
  return null;
}

function buildSnapshotIndex(snapshot){
  const map = new Map();
  if (!snapshot) return map;

  const add = (items, { pending = false, source = null } = {}) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const id = pickListId(item);
      if (!id) continue;

      const entry = map.get(id);
      const candidateTs = parseQBDate(pickRelevantTimestamp(item));
      const candidate = { item, pending: Boolean(pending), source };

      if (!entry) {
        map.set(id, candidate);
        continue;
      }

      const entryTs = parseQBDate(pickRelevantTimestamp(entry.item));
      const mergedPending = entry.pending || candidate.pending;
      let useCandidate = false;

      if (candidate.pending && !entry.pending) {
        useCandidate = true;
      } else if (!entryTs) {
        useCandidate = true;
      } else if (candidateTs && candidateTs > entryTs) {
        useCandidate = true;
      }

      if (useCandidate) {
        map.set(id, { item, pending: mergedPending, source: source || entry.source || null });
      } else if (mergedPending !== entry.pending) {
        map.set(id, { ...entry, pending: mergedPending });
      }
    }
  };

  add(snapshot.allItems, { pending: false, source: 'allItems' });
  add(snapshot.items, { pending: true, source: 'items' });
  return map;
}

function filterUnchangedSnapshotItems(items, previousSnapshot){
  const previousMap = buildSnapshotIndex(previousSnapshot);
  if (!Array.isArray(items) || previousMap.size === 0) {
    return { filtered: Array.isArray(items) ? [...items] : [], skipped: 0 };
  }

  const filtered = [];
  let skipped = 0;

  for (const item of items) {
    const id = pickListId(item);
    if (!id) {
      filtered.push(item);
      continue;
    }

    const prevEntry = previousMap.get(id);
    if (!prevEntry) {
      filtered.push(item);
      continue;
    }

    if (prevEntry.pending) {
      filtered.push(item);
      continue;
    }

    const prev = prevEntry.item;
    const prevQty = Number(prev?.QuantityOnHand);
    const nextQty = Number(item?.QuantityOnHand);
    const sameQty = Number.isFinite(prevQty) && Number.isFinite(nextQty) && prevQty === nextQty;

    if (sameQty) {
      skipped += 1;
      continue;
    }

    const prevTs = parseQBDate(pickRelevantTimestamp(prev));
    const nextTs = parseQBDate(pickRelevantTimestamp(item));
    if (prevTs && nextTs && nextTs <= prevTs) {
      skipped += 1;
      continue;
    }

    filtered.push(item);
  }

  return { filtered, skipped };
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
          await enqueue({ type: 'inventoryQuery', ts: new Date().toISOString() });
        }
        if (process.env.AUTO_ENQUEUE_INVENTORY_QUERY === 'true') {
          await enqueue({ type: 'inventoryQuery', ts: new Date().toISOString() });
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
          save('last-request-qbxml.xml', qbxml);
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
        save(`last-response-${now}.xml`, resp);
        save('last-response.xml', resp);
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
          const previousSnapshot = readJsonSafe('last-inventory.json');
          const parsedItems = parseInventorySnapshot(resp);
          const { filtered: todaysItems, start, end } = filterInventoryForToday(parsedItems);
          const { filtered: recentItems, skipped: unchangedSkipped } =
            filterUnchangedSnapshotItems(todaysItems, previousSnapshot);

          const seenSnapshotKeys = new Set();
          const mergedItems = [];

          const registerSnapshotItem = (item, source) => {
            if (!item) return false;

            const keys = [];
            const listId = pickListId(item);
            if (listId) keys.push(`id:${listId}`);

            const sku = pickSkuForSnapshot(item);
            if (sku) keys.push(`sku:${sku}`);

            if (keys.length === 0) {
              keys.push(`anon:${mergedItems.length}:${source || 'unknown'}`);
            }

            let alreadySeen = false;
            for (const key of keys) {
              if (seenSnapshotKeys.has(key)) {
                alreadySeen = true;
                break;
              }
            }

            for (const key of keys) seenSnapshotKeys.add(key);
            if (alreadySeen) return false;

            mergedItems.push(item);
            return true;
          };

          for (const item of recentItems) {
            registerSnapshotItem(item, 'recent');
          }

          let carriedOver = 0;
          if (Array.isArray(previousSnapshot?.items)) {
            for (const pending of previousSnapshot.items) {
              if (registerSnapshotItem(pending, 'carry')) {
                carriedOver += 1;
              }
            }
          }

          const hasPendingCarryOver = carriedOver > 0;
          const hasRecentChanges = recentItems.length > 0;
          const hasWorkForSync = hasRecentChanges || hasPendingCarryOver;
          const snapshotPayload = {
            count: mergedItems.length,
            filteredAt: new Date().toISOString(),
            filter: {
              mode: 'TimeModifiedSameDay',
              timezoneOffsetMinutes: new Date().getTimezoneOffset(),
              start: start.toISOString(),
              endExclusive: end.toISOString(),
              sourceCount: parsedItems.length,
            },
            items: mergedItems,
            allItems: parsedItems,
            skipped: {
              unchanged: unchangedSkipped,
              previousSnapshotItems: previousSnapshot?.items?.length || 0,
              pendingCarryOver: carriedOver,
            },
          };

            saveJsonAtomic('last-inventory.json', snapshotPayload);
            console.log('[inventory] snapshot filtered for today', {
              totalReceived: parsedItems.length,
              kept: mergedItems.length,
              skippedUnchanged: unchangedSkipped,
              carriedPending: carriedOver,
              start: start.toISOString(),
              end: end.toISOString(),
            });

          try {
            const { runInitialSweepIfNeeded, isInitialSweepEnabled } = require('./services/shopify.sync');
            if (isInitialSweepEnabled()) {
              setImmediate(() =>
                runInitialSweepIfNeeded().catch((err) => {
                  console.error('Initial sweep auto-run error:', err);
                })
              );
            }
          } catch (err) {
            console.error('Initial sweep trigger setup failed:', err);
          }

          // --- Auto push a Shopify (después de persistir el snapshot) ---
          try {
            const m = resp.match(/<ItemInventoryQueryRs[^>]*statusCode="(\d+)"/i);
            const ok = !m || m[1] === '0';
            const auto = shouldAutoPush();

            if (auto && !ok) {
              console.warn('Auto-push skipped due to QuickBooks error status.');
            }

            if (auto && ok && hasWorkForSync) {
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
            } else if (auto && !hasWorkForSync) {
              console.log('Auto-push skipped: no inventory changes or pending carry-over items detected for today.');
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
app.listen(PORT, ()=> console.log(`[QBWC] Listening http://localhost:${PORT}${BASE_PATH}`));