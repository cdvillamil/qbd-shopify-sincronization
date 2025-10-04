// services/shopify.sync.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { findVariantBySKU, getInventoryItemSku, setInventoryLevel } = require('./shopify.client');
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
const INITIAL_SWEEP_STATUS_PATH = path.join(LOG_DIR, 'initial-sweep-status.json');
const INITIAL_SWEEP_QBD_ONLY_PATH = path.join(LOG_DIR, 'initial-sweep-qbd-only.json');
const INITIAL_SWEEP_SHOPIFY_ONLY_PATH = path.join(LOG_DIR, 'initial-sweep-shopify-only.json');
const LOCK_ERROR_CODE = 'SHOPIFY_SYNC_LOCKED';

// --- Debug helpers ---
const DEBUG = /^(1|true|yes)$/i.test(process.env.SHOPIFY_SYNC_DEBUG || '');
const LOG_N = Number(process.env.SHOPIFY_SYNC_DEBUG_LOG_N || 10);
function dbg(...args) { if (DEBUG) console.log('[sync]', ...args); }

// === Shopify GraphQL helpers ===
async function shopifyGraphQL(query) {
  const url = `https://${process.env.SHOPIFY_STORE}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`;

  let attempt = 0;
  while (true) {
    attempt += 1;
    const r = await _fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': process.env.SHOPIFY_TOKEN,
      },
      body: JSON.stringify({ query }),
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

// Devuelve { variant_id, inventory_item_id, sku } o null
async function findVariantBySkuGQL(sku) {
  const s = String(sku || '').trim();
  if (!s) return null;

  const data = await shopifyGraphQL(
    `{ productVariants(first: 5, query:"sku:${s}") { edges { node { id sku inventoryItem { id } } } } }`
  );

  const node = data?.productVariants?.edges?.find(e => e?.node?.sku?.trim() === s)?.node;
  if (!node) return null;

  const variant_id = Number((node.id || '').match(/ProductVariant\/(\d+)/)?.[1]);
  const inventory_item_id = Number((node.inventoryItem?.id || '').match(/InventoryItem\/(\d+)/)?.[1]);
  if (!variant_id || !inventory_item_id) return null;

  return { variant_id, inventory_item_id, sku: node.sku, source: 'gql' };
}

async function confirmRestVariant(variant, sku) {
  if (!variant || !variant.inventory_item_id) return null;

  try {
    const remoteSku = await getInventoryItemSku(variant.inventory_item_id);
    const normalizedRemote = String(remoteSku || '').trim();
    const normalizedSku = String(sku || '').trim();

    if (!normalizedRemote) {
      if (DEBUG) dbg('REST variant rejected: empty remote SKU', { sku, inventory_item_id: variant.inventory_item_id });
      return null;
    }

    if (normalizedRemote !== normalizedSku) {
      if (DEBUG) {
        dbg('REST variant rejected: SKU mismatch', {
          requested: normalizedSku,
          remote: normalizedRemote,
          inventory_item_id: variant.inventory_item_id,
        });
      }
      return null;
    }

    return { ...variant, source: 'rest' };
  } catch (err) {
    if (DEBUG) {
      dbg('REST variant confirmation failed', {
        sku,
        inventory_item_id: variant.inventory_item_id,
        error: err?.message || err,
      });
    }
    return null;
  }
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

function boolFromEnv(value) {
  return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function isInitialSweepEnabled() {
  return boolFromEnv(process.env.INITIAL_SWEEP_ENABLED || process.env.SHOPIFY_INITIAL_SWEEP || '');
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

function pruneSnapshot(successIndices, successListIds) {
  if ((!successIndices || successIndices.size === 0)
    && (!successListIds || successListIds.size === 0)) {
    return { removed: 0, remaining: null };
  }

  const snapshot = loadSnapshot();
  const originalItems = Array.isArray(snapshot.items) ? snapshot.items : [];
  if (!originalItems.length) {
    return { removed: 0, remaining: 0 };
  }

  const remainingItems = originalItems.filter((item, idx) => {
    const idxMatch = successIndices?.has(idx);
    const listId = item?.ListID;
    const listIdMatch = listId != null && successListIds?.has(String(listId));
    return !(idxMatch || listIdMatch);
  });

  if (remainingItems.length === originalItems.length) {
    return { removed: 0, remaining: remainingItems.length };
  }

  const updatedSnapshot = { ...snapshot, items: remainingItems };
  writeSnapshotFile(updatedSnapshot);
  dbg('snapshot pruned', { before: originalItems.length, after: remainingItems.length });
  return { removed: originalItems.length - remainingItems.length, remaining: remainingItems.length };
}

// --- Public API ---
async function buildPlan(limit, options = {}) {
  const { useAllItems = false, includeNoSku = false, includeItemDetails = false } = options || {};
  const snapshot = loadSnapshot();
  const selectedItems = useAllItems && Array.isArray(snapshot.allItems)
    ? snapshot.allItems
    : Array.isArray(snapshot.items) ? snapshot.items : [];
  const items = Array.isArray(selectedItems) ? selectedItems : [];
  const fields = getSkuFieldsPriority();
  dbg('dryRun start', {
    limit: Number(limit || 0),
    snapshotCount: items.length,
    useAllItems,
  });

  const out = [];
  if (!items || items.length === 0) {
    dbg('dryRun: snapshot empty → no ops');
    return { fields, ops: out, sourceItems: items, snapshotSource: useAllItems ? 'allItems' : 'items' };
  }

  let logged = 0;
  for (let idx = 0; idx < items.length; idx += 1) {
    const it = items[idx];
    const sku = pickSku(it, fields);
    if (!sku) {
      if (DEBUG && logged < LOG_N) {
        dbg('item without SKU by fields', { fields, itemKeys: Object.keys(it || {}) });
        logged++;
      }
      if (includeNoSku) {
        const op = {
          sku: null,
          target: Number(it?.QuantityOnHand || 0),
          inventory_item_id: null,
          action: 'MISSING_SKU',
          snapshotIndex: idx,
          listId: it?.ListID || null,
        };
        if (includeItemDetails) op.item = it;
        out.push(op);
      }
      continue;
    }

    const qty = Number(it.QuantityOnHand || 0);
    let variant = null;
    try {
      // 1) Búsqueda exacta por SKU con GraphQL (fiable)
      variant = await findVariantBySkuGQL(sku);
      if (!variant) {
        // 2) Fallback a tu buscador REST existente (por compatibilidad).
        const restVariant = await findVariantBySKU(sku);
        variant = await confirmRestVariant(restVariant, sku);
      }

      if (DEBUG && logged < LOG_N) {
        dbg('SKU lookup', {
          sku, qty,
          found: !!variant,
          source: variant?.source || 'rest',
          inventory_item_id: variant?.inventory_item_id
        });
        logged++;
      }
    } catch (err) {
      console.error('[sync] SKU lookup error for', sku, String(err));
    }


    out.push({
      sku,
      target: qty,
      inventory_item_id: variant?.inventory_item_id || null,
      action: variant ? 'SET_AVAILABLE' : 'NO_MATCH',
      snapshotIndex: idx,
      listId: it?.ListID || null,
      ...(includeItemDetails ? { item: it } : {}),
    });

    if (limit && out.length >= Number(limit)) break;
  }

  dbg('dryRun result:', { ops: out.length, setAvailable: out.filter(x => x.action === 'SET_AVAILABLE').length, noMatch: out.filter(x => x.action === 'NO_MATCH').length });
  return {
    fields,
    ops: out,
    sourceItems: items,
    snapshotSource: useAllItems ? 'allItems' : 'items',
  };
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
      const payload = saveLastPush({ results, snapshotPruned: { removed: 0, remaining: null } });
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

    const successIndices = new Set();
    const successListIds = new Set();
    for (const r of results) {
      if (!r || !r.ok) continue;
      if (r.action !== 'SET_AVAILABLE') continue;
      if (!r.inventory_item_id) continue;

      if (Number.isInteger(r.snapshotIndex)) successIndices.add(r.snapshotIndex);
      if (r.listId != null) successListIds.add(String(r.listId));
    }

    const pruned = pruneSnapshot(successIndices, successListIds);
    const payload = saveLastPush({ results, snapshotPruned: pruned });
    dbg('apply done', {
      ok: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      pruned,
    });
    return { fields: plan.fields, results, lastPush: payload };
  } finally {
    if (typeof releaseLock === 'function') releaseLock();
  }
}

function parseGid(gid, type) {
  const match = String(gid || '').match(new RegExp(`${type}/(\d+)`));
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

async function fetchAllShopifyVariants() {
  const variants = [];
  const configuredPageSize = Number(process.env.SHOPIFY_INITIAL_SWEEP_PAGE_SIZE);
  const pageSize = Number.isFinite(configuredPageSize) && configuredPageSize > 0
    ? Math.min(250, Math.max(1, Math.floor(configuredPageSize)))
    : 250;
  let cursor = null;
  let loops = 0;

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
            inventoryItem { id sku }
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
      variants.push({
        sku: skuValue,
        variantId,
        inventoryItemId,
        productId,
        productTitle: node.product?.title || null,
        productHandle: node.product?.handle || null,
        variantTitle: node.title || null,
        rawSku: node.sku || null,
      });
    }

    const pageInfo = data?.productVariants?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor || (edges.length ? edges[edges.length - 1]?.cursor : null);
    if (!cursor) break;
  }

  return variants;
}

function buildQbdUnmatched(plan) {
  const items = Array.isArray(plan?.sourceItems) ? plan.sourceItems : [];
  const unmatched = [];
  const skuSet = new Set();

  for (const op of Array.isArray(plan?.ops) ? plan.ops : []) {
    const normalizedSku = (op?.sku || '').trim();
    if (normalizedSku) skuSet.add(normalizedSku);

    if (op?.action === 'NO_MATCH' || op?.action === 'MISSING_SKU') {
      const item = Number.isInteger(op.snapshotIndex) ? items[op.snapshotIndex] : null;
      unmatched.push({
        sku: normalizedSku || null,
        listId: op?.listId || item?.ListID || null,
        name: item?.FullName || item?.Name || null,
        quantityOnHand: Number(item?.QuantityOnHand ?? op?.target ?? 0) || 0,
        action: op?.action || 'NO_MATCH',
      });
    }
  }

  return { unmatched, skuSet };
}

function buildShopifyOnly(variants, qbdSkuSet) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return [];
  }

  const out = [];
  for (const variant of variants) {
    const normalizedSku = (variant?.sku || '').trim();
    if (!normalizedSku) continue;
    if (qbdSkuSet.has(normalizedSku)) continue;

    out.push({
      sku: normalizedSku,
      variantId: variant?.variantId || null,
      inventoryItemId: variant?.inventoryItemId || null,
      productId: variant?.productId || null,
      productTitle: variant?.productTitle || null,
      productHandle: variant?.productHandle || null,
      variantTitle: variant?.variantTitle || null,
    });
  }

  return out;
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

function readInitialSweepStatus() {
  return readJsonFile(INITIAL_SWEEP_STATUS_PATH);
}

function readInitialSweepUnmatchedQbd() {
  return readJsonFile(INITIAL_SWEEP_QBD_ONLY_PATH);
}

function readInitialSweepUnmatchedShopify() {
  return readJsonFile(INITIAL_SWEEP_SHOPIFY_ONLY_PATH);
}

async function runInitialSweep() {
  const startedAt = new Date().toISOString();
  writeJsonFile(INITIAL_SWEEP_STATUS_PATH, { status: 'running', startedAt });

  let releaseLock;
  try {
    releaseLock = acquireLock();
  } catch (err) {
    const payload = {
      status: 'failed',
      startedAt,
      finishedAt: new Date().toISOString(),
      error: String(err?.message || err),
      code: err?.code || null,
    };
    writeJsonFile(INITIAL_SWEEP_STATUS_PATH, payload);
    throw err;
  }

  try {
    const plan = await buildPlan(undefined, {
      useAllItems: true,
      includeNoSku: true,
      includeItemDetails: true,
    });
    const { unmatched: qbdUnmatched, skuSet } = buildQbdUnmatched(plan);
    const shopifyVariants = await fetchAllShopifyVariants();
    const shopifyOnly = buildShopifyOnly(shopifyVariants, skuSet);

    const generatedAt = new Date().toISOString();
    writeJsonFile(INITIAL_SWEEP_QBD_ONLY_PATH, {
      generatedAt,
      count: qbdUnmatched.length,
      items: qbdUnmatched,
    });
    writeJsonFile(INITIAL_SWEEP_SHOPIFY_ONLY_PATH, {
      generatedAt,
      count: shopifyOnly.length,
      items: shopifyOnly,
    });

    const operations = plan.ops.filter(op => op?.action === 'SET_AVAILABLE' && op?.inventory_item_id);
    const results = [];
    for (const op of operations) {
      try {
        await setInventoryLevel(op.inventory_item_id, op.target);
        results.push({ ...op, ok: true });
      } catch (err) {
        console.error('[sync] initial sweep setInventoryLevel error', {
          sku: op?.sku,
          inventory_item_id: op?.inventory_item_id,
          target: op?.target,
          error: err?.message || err,
        });
        results.push({ ...op, ok: false, error: String(err?.message || err) });
      }
    }

    const summary = summarizeResults(results);
    const finishedAt = new Date().toISOString();
    const statusPayload = {
      status: 'completed',
      startedAt,
      finishedAt,
      operationsPlanned: operations.length,
      ...summary,
      unmatchedQbd: qbdUnmatched.length,
      unmatchedShopify: shopifyOnly.length,
      snapshotSource: plan.snapshotSource,
    };
    writeJsonFile(INITIAL_SWEEP_STATUS_PATH, statusPayload);
    return statusPayload;
  } catch (err) {
    const finishedAt = new Date().toISOString();
    writeJsonFile(INITIAL_SWEEP_STATUS_PATH, {
      status: 'failed',
      startedAt,
      finishedAt,
      error: String(err?.message || err),
      code: err?.code || null,
    });
    throw err;
  } finally {
    if (typeof releaseLock === 'function') releaseLock();
  }
}

async function runInitialSweepIfNeeded() {
  if (!isInitialSweepEnabled()) {
    return null;
  }

  const status = readInitialSweepStatus();
  if (status?.status === 'completed' || status?.status === 'running') {
    return status;
  }

  try {
    return await runInitialSweep();
  } catch (err) {
    if (DEBUG) {
      console.warn('[sync] initial sweep failed:', err?.message || err);
    }
    throw err;
  }
}

module.exports = {
  dryRun,
  apply,
  isSyncLocked,
  findVariantBySkuGQL,
  shopifyGraphQL,
  LOCK_ERROR_CODE,
  runInitialSweep,
  runInitialSweepIfNeeded,
  readInitialSweepStatus,
  readInitialSweepUnmatchedQbd,
  readInitialSweepUnmatchedShopify,
  isInitialSweepEnabled,
};
