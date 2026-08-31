// services/shopify.sync.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { setInventoryLevel } = require('./shopify.client');
const { LOG_DIR, ensureDir: ensureLogDir } = require('./jobQueue');
// Polyfill: usa fetch nativo (Node>=18) o node-fetch si hace falta
const _fetch = (typeof fetch === 'function')
  ? fetch
  : (...args) => import('node-fetch').then(m => m.default(...args));

const GQL_MAX_THROTTLE_RETRIES = (() => {
  const n = Number(process.env.SHOPIFY_GQL_THROTTLE_RETRIES);
  return Number.isFinite(n) && n >= 0 ? n : 5;
})();
const GQL_BASE_THROTTLE_DELAY_MS = (() => {
  const n = Number(process.env.SHOPIFY_GQL_THROTTLE_BASE_DELAY_MS);
  return Number.isFinite(n) && n > 0 ? n : 750;
})();
const GQL_MAX_THROTTLE_DELAY_MS = (() => {
  const n = Number(process.env.SHOPIFY_GQL_THROTTLE_MAX_DELAY_MS);
  return Number.isFinite(n) && n > 0 ? n : 5_000;
})();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));
}

const SNAP_PATH = path.join(LOG_DIR, 'last-inventory.json');
const SNAP_BAK_PATH = `${SNAP_PATH}.bak`;
const SNAP_TMP_PATH = `${SNAP_PATH}.tmp`;
const LAST_PUSH_PATH = path.join(LOG_DIR, 'shopify-last-pushed.json');
const LOCK_PATH = path.join(LOG_DIR, 'shopify-sync.lock');
const LOCK_ERROR_CODE = 'SHOPIFY_SYNC_LOCKED';

// --- Debug helpers ---
const DEBUG = /^(1|true|yes)$/i.test(process.env.SHOPIFY_SYNC_DEBUG || '');
const LOG_N = Number(process.env.SHOPIFY_SYNC_DEBUG_LOG_N || 10);
function dbg(...args) { if (DEBUG) console.log('[sync]', ...args); }

// === Shopify GraphQL helpers ===
async function shopifyGraphQL(query, variables) {
  const url = `https://${process.env.SHOPIFY_STORE}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;

  let attempt = 0;
  while (true) {
    attempt += 1;
    const payload = { query };
    if (variables && typeof variables === 'object' && Object.keys(variables).length > 0) {
      payload.variables = variables;
    }
    const r = await _fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN,
      },
      body: JSON.stringify(payload),
    });

    const json = await r.json().catch(() => ({}));
    const errors = Array.isArray(json?.errors) ? json.errors : [];
    const throttled = (r.status === 429)
      || errors.some(err => {
        const code = err?.extensions?.code || '';
        const message = err?.message || '';
        return String(code).toUpperCase() === 'THROTTLED' || /throttled/i.test(message);
      });

    if (!r.ok || errors.length > 0) {
      if (throttled && attempt <= GQL_MAX_THROTTLE_RETRIES) {
        const retryAfterHeader = Number(r.headers?.get?.('Retry-After'));
        const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? Math.round(retryAfterHeader * 1000)
          : Math.min(GQL_MAX_THROTTLE_DELAY_MS, GQL_BASE_THROTTLE_DELAY_MS * (2 ** (attempt - 1)));
        dbg('shopifyGraphQL throttled, retrying', { attempt, waitMs });
        await sleep(waitMs);
        continue;
      }

      throw new Error(`Shopify GraphQL ${r.status}: ${JSON.stringify(json.errors || json)}`);
    }

    return json.data;
  }
}

// Normaliza un SKU para comparar: colapsa espacios, recorta y pasa a mayúsculas.
function normSku(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toUpperCase();
}

// Escapa un valor para incrustarlo entre comillas en la query de búsqueda de Shopify.
function escapeSearchValue(v) {
  return String(v == null ? '' : v).replace(/(["\\])/g, '\\$1');
}

/**
 * Busca la variante de Shopify por SKU (solo GraphQL; el REST top-level ya no
 * filtra de forma fiable en las versiones actuales de la API).
 * Devuelve { variant_id, inventory_item_id, sku, matchType, source } o null.
 *   matchType: 'exact' | 'normalized'
 * Si no hay match pero la búsqueda devolvió candidatos, se agregan a `outCandidates`.
 */
async function findVariantBySkuGQL(sku, outCandidates) {
  const raw = String(sku || '').trim();
  if (!raw) return null;
  const target = normSku(raw);

  const gql = `query FindVariantBySku($query: String!) {
    productVariants(first: 20, query: $query) {
      edges { node { id sku displayName inventoryItem { id } } }
    }
  }`;

  let nodes = [];
  try {
    const data = await shopifyGraphQL(gql, { query: `sku:"${escapeSearchValue(raw)}"` });
    nodes = (data?.productVariants?.edges || []).map(e => e?.node).filter(Boolean);
  } catch (err) {
    console.error('[sync] GraphQL SKU search failed', { sku: raw, error: err?.message || err });
    return null;
  }

  if (Array.isArray(outCandidates)) {
    for (const n of nodes) if (n.sku) outCandidates.push(n.sku);
  }

  let node = nodes.find(n => String(n.sku || '').trim() === raw);
  let matchType = node ? 'exact' : null;
  if (!node) {
    node = nodes.find(n => normSku(n.sku) === target);
    if (node) matchType = 'normalized';
  }
  if (!node) {
    if (DEBUG && nodes.length) {
      dbg('SKU sin match exacto', { requested: raw, candidates: nodes.map(n => n.sku) });
    }
    return null;
  }

  const variant_id = Number(String(node.id || '').match(/ProductVariant\/(\d+)/)?.[1]);
  const inventory_item_id = Number(String(node.inventoryItem?.id || '').match(/InventoryItem\/(\d+)/)?.[1]);
  if (!variant_id || !inventory_item_id) return null;

  return { variant_id, inventory_item_id, sku: node.sku, matchType, source: 'gql' };
}

// --- SKU field priority ---
function getSkuFieldsPriority() {
  const env = process.env.QBD_SKU_FIELDS || process.env.QBD_SKU_FIELD || 'Name';
  const fields = env.split(',').map(s => s.trim()).filter(Boolean);
  dbg('SKU fields priority =', fields);
  return fields;
}
function pickSku(it, fields) {
  for (const f of fields) {
    const v = (it[f] || '').trim();
    if (v) return v;
  }
  return null;
}

// --- Snapshot helpers ---
function readSnapshotFrom(pathname) {
  try {
    if (!fs.existsSync(pathname)) return null;
    const raw = fs.readFileSync(pathname, 'utf8');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    if (DEBUG) {
      console.warn('[sync] snapshot read error:', { path: pathname, error: err?.message || err });
    }
    return null;
  }
}

function loadSnapshot() {
  let snapshot = readSnapshotFrom(SNAP_PATH);
  if (!snapshot) {
    snapshot = readSnapshotFrom(SNAP_BAK_PATH);
    if (snapshot) {
      console.warn('[sync] snapshot primary missing/corrupt, using backup');
    }
  }

  if (!snapshot) {
    dbg('snapshot not found at', SNAP_PATH);
    return { items: [] };
  }

  const count = Array.isArray(snapshot.items) ? snapshot.items.length : 0;
  dbg('snapshot loaded:', { count, path: SNAP_PATH });
  if (DEBUG && count > 0) {
    const sample = snapshot.items.slice(0, Math.min(LOG_N, count)).map(x => ({
      Name: x.Name, BarCodeValue: x.BarCodeValue, ListID: x.ListID, QOH: x.QuantityOnHand
    }));
    dbg('snapshot sample (first ' + sample.length + '):', sample);
  }

  return snapshot;
}

function writeSnapshotFile(value) {
  ensureLogDir();
  const payload = JSON.stringify(value ?? { items: [] }, null, 2);

  try {
    if (fs.existsSync(SNAP_PATH)) {
      try {
        fs.copyFileSync(SNAP_PATH, SNAP_BAK_PATH);
      } catch (err) {
        if (DEBUG) {
          console.warn('[sync] snapshot backup copy failed:', err?.message || err);
        }
      }
    }

    fs.writeFileSync(SNAP_TMP_PATH, payload, 'utf8');
    fs.renameSync(SNAP_TMP_PATH, SNAP_PATH);

    try {
      fs.copyFileSync(SNAP_PATH, SNAP_BAK_PATH);
    } catch (err) {
      if (DEBUG) {
        console.warn('[sync] snapshot backup refresh failed:', err?.message || err);
      }
    }
  } catch (err) {
    console.error('[sync] snapshot write error:', err?.message || err);
    try {
      if (fs.existsSync(SNAP_TMP_PATH)) fs.rmSync(SNAP_TMP_PATH, { force: true });
    } catch (rmErr) {
      if (DEBUG) {
        console.warn('[sync] snapshot tmp cleanup failed:', rmErr?.message || rmErr);
      }
    }
    throw err;
  }
}

function writeJsonFile(pathname, value) {
  ensureLogDir();
  const payload = JSON.stringify(value ?? null, null, 2);
  fs.writeFileSync(pathname, payload, 'utf8');
}

function readJsonFile(pathname) {
  try {
    if (!fs.existsSync(pathname)) return null;
    const raw = fs.readFileSync(pathname, 'utf8');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    if (DEBUG) {
      console.warn('[sync] json read error:', { path: pathname, error: err?.message || err });
    }
    return null;
  }
}

function saveLastPush(plan) {
  const payload = { pushedAt: new Date().toISOString(), ...plan };
  ensureLogDir();
  fs.writeFileSync(LAST_PUSH_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function isSyncLocked() {
  try {
    return fs.existsSync(LOCK_PATH);
  } catch (err) {
    if (DEBUG) {
      console.warn('[sync] lock check error:', err?.message || err);
    }
    return false;
  }
}

function acquireLock() {
  ensureLogDir();
  const lockMeta = {
    pid: process.pid,
    hostname: os.hostname(),
    acquiredAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(LOCK_PATH, JSON.stringify(lockMeta, null, 2), { flag: 'wx' });
    dbg('sync lock acquired', { path: LOCK_PATH });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      let info = null;
      try { info = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')); }
      catch (readErr) {
        if (DEBUG) {
          console.warn('[sync] lock read error:', readErr?.message || readErr);
        }
      }
      const e = new Error('Shopify sync already running.');
      e.code = LOCK_ERROR_CODE;
      if (info) e.lock = info;
      throw e;
    }
    throw err;
  }

  return () => {
    try {
      fs.unlinkSync(LOCK_PATH);
      dbg('sync lock released', { path: LOCK_PATH });
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.error('[sync] lock release error:', err?.message || err);
      }
    }
  };
}

// --- Public API ---
async function buildPlan(limit) {
  const snapshot = loadSnapshot();
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const fields = getSkuFieldsPriority();
  dbg('buildPlan start', { limit: Number(limit || 0), snapshotCount: items.length });

  const out = [];
  if (items.length === 0) {
    dbg('buildPlan: snapshot vacío → sin ops');
    return { fields, ops: out, sourceItems: items };
  }

  let logged = 0;
  for (let idx = 0; idx < items.length; idx += 1) {
    const it = items[idx];
    const sku = pickSku(it, fields);
    if (!sku) {
      if (DEBUG && logged < LOG_N) {
        dbg('item sin SKU por fields', { fields, itemKeys: Object.keys(it || {}) });
        logged++;
      }
      continue;
    }

    const qty = Math.max(0, Number(it.QuantityOnHand || 0));
    let variant = null;
    const candidates = [];
    try {
      variant = await findVariantBySkuGQL(sku, candidates);
      if (DEBUG && logged < LOG_N) {
        dbg('SKU lookup', {
          sku, qty,
          found: !!variant,
          matchType: variant?.matchType || null,
          inventory_item_id: variant?.inventory_item_id,
          candidates: variant ? undefined : candidates,
        });
        logged++;
      }
    } catch (err) {
      console.error('[sync] SKU lookup error for', sku, String(err));
    }

    const op = {
      sku,
      target: qty,
      inventory_item_id: variant?.inventory_item_id || null,
      action: variant ? 'SET_AVAILABLE' : 'NO_MATCH',
      matchType: variant?.matchType || null,
      snapshotIndex: idx,
      listId: it?.ListID || null,
    };
    if (!variant && candidates.length) {
      op.candidates = Array.from(new Set(candidates)).slice(0, 10);
    }
    out.push(op);

    if (limit && out.length >= Number(limit)) break;
  }

  dbg('buildPlan result:', {
    ops: out.length,
    setAvailable: out.filter(x => x.action === 'SET_AVAILABLE').length,
    noMatch: out.filter(x => x.action === 'NO_MATCH').length,
  });
  return { fields, ops: out, sourceItems: items };
}

async function dryRun(limit) {
  if (isSyncLocked()) {
    const err = new Error('Shopify sync already running.');
    err.code = LOCK_ERROR_CODE;
    throw err;
  }
  return buildPlan(limit);
}

async function apply(limit) {
  let releaseLock;
  try {
    releaseLock = acquireLock();
  } catch (err) {
    if (err && err.code === LOCK_ERROR_CODE) {
      dbg('apply skipped: lock busy');
    }
    throw err;
  }

  try {
    const plan = await buildPlan(limit);
    const results = [];
    dbg('apply start', { plannedOps: plan.ops.length });

    if (!plan.ops.length) {
      dbg('apply: no ops to execute');
      const payload = saveLastPush({ results });
      return { fields: plan.fields, results, lastPush: payload };
    }

    for (const op of plan.ops) {
      if (op.action !== 'SET_AVAILABLE' || !op.inventory_item_id) {
        if (DEBUG) dbg('apply skip', { reason: 'NO_MATCH', sku: op.sku });
        results.push({ ...op, ok: false, error: 'NO_MATCH' });
        continue;
      }
      try {
        if (DEBUG) dbg('apply set', { sku: op.sku, inventory_item_id: op.inventory_item_id, target: op.target });
        await setInventoryLevel(op.inventory_item_id, op.target);
        results.push({ ...op, ok: true });
      } catch (e) {
        console.error('[sync] setInventoryLevel error', { sku: op.sku, inventory_item_id: op.inventory_item_id, target: op.target, err: String(e && e.message || e) });
        results.push({ ...op, ok: false, error: String(e.message || e) });
      }
    }

    // Persistir el resultado por ítem en el estado de sincronización.
    let stateSummary = { ok: 0, unmatched: 0, error: 0 };
    try {
      const { recordResults } = require('./syncState');
      const s = recordResults(results);
      stateSummary = { ok: s.ok, unmatched: s.unmatched, error: s.error };
      writeJsonFile(path.join(LOG_DIR, 'shopify-unmatched.json'), {
        generatedAt: new Date().toISOString(),
        count: s.unmatchedItems.length,
        items: s.unmatchedItems,
      });
    } catch (err) {
      console.error('[sync] syncState update failed:', err?.message || err);
    }

    const summary = summarizeResults(results);
    try {
      writeJsonFile(path.join(LOG_DIR, 'shopify-sync-health.json'), {
        finishedAt: new Date().toISOString(),
        planned: plan.ops.length,
        success: summary.success,
        failed: summary.failed,
        state: stateSummary,
        errors: summary.errors,
      });
    } catch (err) {
      console.error('[sync] sync-health write failed:', err?.message || err);
    }

    const payload = saveLastPush({ results, stateSummary });
    dbg('apply done', { ok: summary.success, failed: summary.failed, state: stateSummary });
    return { fields: plan.fields, results, lastPush: payload, stateSummary };
  } finally {
    if (typeof releaseLock === 'function') releaseLock();
  }
}

function parseGid(gid, type) {
  // OJO: en un template literal `\d` se colapsa a `d`; hay que escaparlo como `\\d`.
  const match = String(gid || '').match(new RegExp(`${type}/(\\d+)`));
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function locationGid() {
  const raw = String(process.env.SHOPIFY_LOCATION_ID || '').trim();
  if (!raw) return null;
  return /^gid:/.test(raw) ? raw : `gid://shopify/Location/${raw}`;
}

async function fetchAllShopifyVariants({ withAvailable = false } = {}) {
  const variants = [];
  const configuredPageSize = Number(process.env.SHOPIFY_VARIANTS_PAGE_SIZE);
  const pageSize = Number.isFinite(configuredPageSize) && configuredPageSize > 0
    ? Math.min(250, Math.max(1, Math.floor(configuredPageSize)))
    : 250;
  let cursor = null;
  let loops = 0;

  const loc = withAvailable ? locationGid() : null;
  const availableField = loc
    ? `inventoryLevel(locationId: ${JSON.stringify(loc)}) { quantities(names: ["available"]) { name quantity } }`
    : '';

  while (true) {
    loops += 1;
    if (loops > 10_000) {
      throw new Error('Shopify variant pagination exceeded safety limit (10000 iterations).');
    }

    const afterClause = cursor ? `, after: ${JSON.stringify(cursor)}` : '';
    const query = `{
      productVariants(first: ${pageSize}${afterClause}) {
        edges {
          cursor
          node {
            id
            sku
            title
            inventoryItem { id sku ${availableField} }
            product { id title handle }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }`;

    const data = await shopifyGraphQL(query);
    const edges = data?.productVariants?.edges || [];
    for (const edge of edges) {
      const node = edge?.node;
      if (!node) continue;
      const variantId = parseGid(node.id, 'ProductVariant');
      const inventoryItemId = parseGid(node.inventoryItem?.id, 'InventoryItem');
      const productId = parseGid(node.product?.id, 'Product');
      const skuValue = (node.sku || node.inventoryItem?.sku || '').trim();

      let available = null;
      if (loc) {
        const q = node.inventoryItem?.inventoryLevel?.quantities?.find(x => x?.name === 'available');
        if (q && Number.isFinite(Number(q.quantity))) available = Number(q.quantity);
      }

      variants.push({
        sku: skuValue,
        variantId,
        inventoryItemId,
        productId,
        productTitle: node.product?.title || null,
        productHandle: node.product?.handle || null,
        variantTitle: node.title || null,
        rawSku: node.sku || null,
        available,
      });
    }

    const pageInfo = data?.productVariants?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor || (edges.length ? edges[edges.length - 1]?.cursor : null);
    if (!cursor) break;
  }

  return variants;
}

function summarizeResults(results) {
  const success = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const errors = results
    .filter(r => !r.ok)
    .map(r => ({
      sku: r?.sku || null,
      inventory_item_id: r?.inventory_item_id || null,
      target: r?.target ?? null,
      error: r?.error || null,
    }));

  return { success, failed, errors };
}

/**
 * Comparación en vivo QBD (allItems del último snapshot) vs Shopify por SKU.
 * No compara cantidades (eso llega en la reconciliación completa); revela qué
 * ítems de QBD no tienen variante en Shopify (causa de los NO_MATCH) y viceversa.
 */
async function computeDrift() {
  const snapshot = loadSnapshot();
  const qbdItems = Array.isArray(snapshot.allItems) && snapshot.allItems.length
    ? snapshot.allItems
    : (Array.isArray(snapshot.items) ? snapshot.items : []);
  const fields = getSkuFieldsPriority();
  const variants = await fetchAllShopifyVariants();

  // Comparación con la misma normalización que usa el push real (normSku).
  const shopSkus = new Set();
  for (const v of variants) {
    const s = normSku(v.sku);
    if (s) shopSkus.add(s);
  }

  const qbdOnly = [];
  const qbdSkus = new Set();
  for (const it of qbdItems) {
    const sku = pickSku(it, fields);
    const qbdQty = Math.max(0, Number(it?.QuantityOnHand || 0));
    if (!sku) {
      qbdOnly.push({ listId: it?.ListID || null, name: it?.FullName || it?.Name || null, qbdQty, reason: 'MISSING_SKU' });
      continue;
    }
    qbdSkus.add(normSku(sku));
    if (!shopSkus.has(normSku(sku))) {
      qbdOnly.push({ listId: it?.ListID || null, sku, name: it?.FullName || it?.Name || null, qbdQty, reason: 'NO_SHOPIFY_VARIANT' });
    }
  }

  const shopifyOnly = [];
  for (const v of variants) {
    const s = (v.sku || '').trim();
    if (!s) continue;
    if (!qbdSkus.has(normSku(s))) {
      shopifyOnly.push({ sku: s, variantId: v.variantId, productTitle: v.productTitle, productHandle: v.productHandle });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    qbdCatalog: qbdItems.length,
    shopifyVariants: variants.length,
    qbdUnmatched: qbdOnly.length,
    shopifyUnmatched: shopifyOnly.length,
    skuFields: fields,
    qbdOnly,
    shopifyOnly,
  };

  try {
    writeJsonFile(path.join(LOG_DIR, 'shopify-drift.json'), report);
  } catch (err) {
    console.error('[sync] drift report write failed:', err?.message || err);
  }
  return report;
}

// ===================================================================
//  Fase 3 — Reconciliación completa QBD vs Shopify (por cantidad)
// ===================================================================
const RECONCILE_STATUS_PATH = path.join(LOG_DIR, 'shopify-reconcile.json');

function reconcileIntervalMs() {
  const n = Number(process.env.SHOPIFY_RECONCILE_INTERVAL_MS);
  return Number.isFinite(n) && n > 0 ? n : 6 * 60 * 60 * 1000; // 6 h
}
function reconcileMax() {
  const n = Number(process.env.SHOPIFY_RECONCILE_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}
function isReconcileEnabled() {
  return /^(1|true|yes)$/i.test(String(process.env.SHOPIFY_RECONCILE_ENABLED || '').trim());
}
function readReconcileStatus() {
  return readJsonFile(RECONCILE_STATUS_PATH);
}

/**
 * Compara TODO el catálogo de QBD (allItems del último snapshot) contra las
 * cantidades reales de Shopify y corrige las diferencias empujando el valor de
 * QBD (source of truth). No avanza ningún cursor: es idempotente.
 *
 * @param {{ limit?: number, dryRun?: boolean }} opts
 */
async function runReconcile(opts = {}) {
  const startedAt = new Date().toISOString();
  const dry = Boolean(opts.dryRun);
  const cap = Math.max(1, Math.floor(opts.limit || reconcileMax()));

  let releaseLock;
  try {
    releaseLock = acquireLock();
  } catch (err) {
    // Colisión con otro sync: no marcamos 'failed' (se reintenta en el próximo poll).
    if (!(err && err.code === LOCK_ERROR_CODE)) {
      const payload = { status: 'failed', startedAt, finishedAt: new Date().toISOString(),
        error: String(err?.message || err), code: err?.code || null };
      try { writeJsonFile(RECONCILE_STATUS_PATH, payload); } catch (_) {}
    }
    throw err;
  }

  try {
    writeJsonFile(RECONCILE_STATUS_PATH, { status: 'running', startedAt, dryRun: dry });

    if (!locationGid()) {
      throw new Error('SHOPIFY_LOCATION_ID no configurado; no se puede leer la cantidad real de Shopify.');
    }

    const snapshot = loadSnapshot();
    const qbdItems = Array.isArray(snapshot.allItems) && snapshot.allItems.length
      ? snapshot.allItems
      : (Array.isArray(snapshot.items) ? snapshot.items : []);
    if (!qbdItems.length) {
      throw new Error('No hay catálogo de QBD en last-inventory.json; corre un inventoryQuery primero.');
    }

    const fields = getSkuFieldsPriority();
    const variants = await fetchAllShopifyVariants({ withAvailable: true });
    const shopBySku = new Map();
    for (const v of variants) {
      const k = normSku(v.sku);
      if (k && !shopBySku.has(k)) shopBySku.set(k, v);
    }

    const toFix = [];
    const unmatched = [];
    const verified = []; // ya alineados: {listId, sku, qbdQty, shopifyQty}
    let diffsTotal = 0;

    for (const it of qbdItems) {
      const sku = pickSku(it, fields);
      const listId = it?.ListID || null;
      const qbdQty = Math.max(0, Number(it?.QuantityOnHand || 0));

      if (!sku) {
        unmatched.push({ listId, name: it?.FullName || it?.Name || null, qbdQty, reason: 'MISSING_SKU' });
        continue;
      }
      const v = shopBySku.get(normSku(sku));
      if (!v || !v.inventoryItemId) {
        unmatched.push({ listId, sku, name: it?.FullName || it?.Name || null, qbdQty, reason: 'NO_SHOPIFY_VARIANT' });
        continue;
      }
      if (v.available == null) {
        unmatched.push({ listId, sku, qbdQty, reason: 'NO_LEVEL_AT_LOCATION' });
        continue;
      }
      if (Number(v.available) === qbdQty) {
        verified.push({ listId, sku, qbdQty, shopifyQty: Number(v.available) });
        continue;
      }
      diffsTotal += 1;
      if (toFix.length < cap) {
        toFix.push({
          sku, listId,
          inventory_item_id: v.inventoryItemId,
          target: qbdQty,
          shopifyQtyBefore: Number(v.available),
          action: 'SET_AVAILABLE',
        });
      }
    }

    const results = [];
    if (!dry) {
      for (const op of toFix) {
        try {
          await setInventoryLevel(op.inventory_item_id, op.target);
          results.push({ ...op, ok: true });
        } catch (e) {
          console.error('[sync] reconcile setInventoryLevel error', { sku: op.sku, target: op.target, err: String(e?.message || e) });
          results.push({ ...op, ok: false, error: String(e?.message || e) });
        }
      }
    }

    // Actualiza el estado: resultados del push + los verificados como alineados.
    let stateSummary = { ok: 0, unmatched: 0, error: 0 };
    if (!dry) {
      try {
        const { recordResults, readState, writeState } = require('./syncState');
        const s = recordResults(results);
        stateSummary = { ok: s.ok, unmatched: s.unmatched, error: s.error };

        const state = readState();
        const nowIso = new Date().toISOString();
        for (const vf of verified) {
          if (!vf.listId) continue;
          const prev = state.byKey[String(vf.listId)] || { attempts: 0 };
          state.byKey[String(vf.listId)] = {
            ...prev,
            sku: vf.sku ?? prev.sku ?? null,
            qbdQty: vf.qbdQty,
            shopifyQty: vf.shopifyQty,
            status: 'ok',
            lastAttemptAt: nowIso,
            lastError: null,
          };
        }
        for (const um of unmatched) {
          if (!um.listId) continue;
          const prev = state.byKey[String(um.listId)] || { attempts: 0 };
          state.byKey[String(um.listId)] = {
            ...prev,
            sku: um.sku ?? prev.sku ?? null,
            qbdQty: um.qbdQty,
            shopifyQty: prev.shopifyQty ?? null,
            status: 'unmatched',
            lastAttemptAt: nowIso,
            lastError: um.reason || 'NO_MATCH',
          };
          stateSummary.unmatched += 1;
        }
        writeState(state);
      } catch (err) {
        console.error('[sync] reconcile state update failed:', err?.message || err);
      }
    }

    const report = {
      status: 'completed',
      startedAt,
      finishedAt: new Date().toISOString(),
      dryRun: dry,
      qbdCatalog: qbdItems.length,
      shopifyVariants: variants.length,
      inSync: verified.length,
      diffsFound: diffsTotal,
      diffsProcessed: toFix.length,
      corrected: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      unmatched: unmatched.length,
      capped: diffsTotal > toFix.length,
      cap,
      state: stateSummary,
      diffs: (dry ? toFix : results).slice(0, 1000),
      unmatchedSample: unmatched.slice(0, 1000),
    };
    writeJsonFile(RECONCILE_STATUS_PATH, report);
    console.log('[sync] reconcile done', {
      dryRun: dry, inSync: report.inSync, diffsFound: report.diffsFound,
      corrected: report.corrected, failed: report.failed, unmatched: report.unmatched, capped: report.capped,
    });
    return report;
  } catch (err) {
    const payload = { status: 'failed', startedAt, finishedAt: new Date().toISOString(),
      error: String(err?.message || err), code: err?.code || null };
    try { writeJsonFile(RECONCILE_STATUS_PATH, payload); } catch (_) {}
    throw err;
  } finally {
    if (typeof releaseLock === 'function') releaseLock();
  }
}

// Corre la reconciliación si está habilitada y venció el intervalo. No lanza.
async function runReconcileIfDue() {
  if (!isReconcileEnabled()) return null;
  try {
    const last = readReconcileStatus();
    const lastAt = Date.parse(last?.finishedAt || '') || 0;
    if (last?.status === 'running') return null;
    if (last?.status === 'completed' && lastAt && Date.now() - lastAt < reconcileIntervalMs()) return null;
    // Tras un fallo real, espera 20 min antes de reintentar (evita loops).
    if (last?.status === 'failed' && lastAt && Date.now() - lastAt < 20 * 60 * 1000) return null;
    if (isSyncLocked()) return null;
    return await runReconcile();
  } catch (err) {
    if (!(err && err.code === LOCK_ERROR_CODE)) {
      console.error('[sync] reconcile auto-run error:', err?.message || err);
    }
    return null;
  }
}

module.exports = {
  dryRun,
  apply,
  computeDrift,
  runReconcile,
  runReconcileIfDue,
  readReconcileStatus,
  isReconcileEnabled,
  isSyncLocked,
  findVariantBySkuGQL,
  shopifyGraphQL,
  LOCK_ERROR_CODE,
};
