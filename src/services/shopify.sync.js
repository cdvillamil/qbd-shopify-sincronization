// services/shopify.sync.js
const fs = require('fs');
const path = require('path');
const os = require('os');
const { findVariantBySKU, setInventoryLevel } = require('./shopify.client');
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
async function buildPlan(limit) {
  const snapshot = loadSnapshot();
  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  const fields = getSkuFieldsPriority();
  dbg('dryRun start', { limit: Number(limit || 0), snapshotCount: items.length });

  const out = [];
  if (!items || items.length === 0) {
    dbg('dryRun: snapshot empty → no ops');
    return { fields, ops: out };
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
      continue;
    }

    const qty = Number(it.QuantityOnHand || 0);
    let variant = null;
    try {
      // 1) Búsqueda exacta por SKU con GraphQL (fiable)
      variant = await findVariantBySkuGQL(sku);
      if (!variant) {
        // 2) Fallback a tu buscador REST existente (por compatibilidad)
        variant = await findVariantBySKU(sku);
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
    });

    if (limit && out.length >= Number(limit)) break;
  }

  dbg('dryRun result:', { ops: out.length, setAvailable: out.filter(x => x.action === 'SET_AVAILABLE').length, noMatch: out.filter(x => x.action === 'NO_MATCH').length });
  return { fields, ops: out };
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
      if (r && r.ok) {
        if (Number.isInteger(r.snapshotIndex)) successIndices.add(r.snapshotIndex);
        if (r.listId != null) successListIds.add(String(r.listId));
      }
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

module.exports = {
  dryRun,
  apply,
  isSyncLocked,
  findVariantBySkuGQL,
  shopifyGraphQL,
  LOCK_ERROR_CODE,
};
