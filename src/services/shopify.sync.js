// services/shopify.sync.js
const fs = require('fs');
const path = require('path');
const { findVariantBySKU, setInventoryLevel } = require('./shopify.client');

const TMP_DIR = '/tmp';
const SNAP_PATH = path.join(TMP_DIR, 'last-inventory.json');
const LAST_PUSH_PATH = path.join(TMP_DIR, 'shopify-last-pushed.json');

// --- Debug helpers ---
const DEBUG = /^(1|true|yes)$/i.test(process.env.SHOPIFY_SYNC_DEBUG || '');
const LOG_N = Number(process.env.SHOPIFY_SYNC_DEBUG_LOG_N || 10);
function dbg(...args) { if (DEBUG) console.log('[sync]', ...args); }

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
function loadSnapshot() {
  if (!fs.existsSync(SNAP_PATH)) {
    dbg('snapshot not found at', SNAP_PATH);
    return { items: [] };
  }
  try {
    const raw = fs.readFileSync(SNAP_PATH, 'utf8');
    const j = JSON.parse(raw) || { items: [] };
    const count = Array.isArray(j.items) ? j.items.length : 0;
    dbg('snapshot loaded:', { count, path: SNAP_PATH });
    if (DEBUG && count > 0) {
      // Muestra algunos ejemplos de campos para validar mapeos
      const sample = j.items.slice(0, Math.min(LOG_N, count)).map(x => ({
        Name: x.Name, BarCodeValue: x.BarCodeValue, ListID: x.ListID, QOH: x.QuantityOnHand
      }));
      dbg('snapshot sample (first ' + sample.length + '):', sample);
    }
    return j;
  } catch (e) {
    console.error('[sync] snapshot parse error:', e);
    return { items: [] };
  }
}
function saveLastPush(plan) {
  const payload = { pushedAt: new Date().toISOString(), ...plan };
  fs.writeFileSync(LAST_PUSH_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

// --- Public API ---
async function dryRun(limit) {
  const { items } = loadSnapshot();
  const fields = getSkuFieldsPriority();
  dbg('dryRun start', { limit: Number(limit || 0), snapshotCount: items.length });

  const out = [];
  if (!items || items.length === 0) {
    dbg('dryRun: snapshot empty → no ops');
    return { fields, ops: out };
  }

  let logged = 0;
  for (const it of items) {
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
      variant = await findVariantBySKU(sku);
      if (DEBUG && logged < LOG_N) {
        dbg('SKU lookup', { sku, qty, found: !!variant, inventory_item_id: variant?.inventory_item_id });
        logged++;
      }
    } catch (err) {
      console.error('[sync] findVariantBySKU error for', sku, String(err));
    }

    out.push({
      sku,
      target: qty,
      inventory_item_id: variant?.inventory_item_id || null,
      action: variant ? 'SET_AVAILABLE' : 'NO_MATCH',
    });

    if (limit && out.length >= Number(limit)) break;
  }

  dbg('dryRun result:', { ops: out.length, setAvailable: out.filter(x => x.action === 'SET_AVAILABLE').length, noMatch: out.filter(x => x.action === 'NO_MATCH').length });
  return { fields, ops: out };
}

async function apply(limit) {
  const plan = await dryRun(limit);
  const results = [];
  dbg('apply start', { plannedOps: plan.ops.length });

  if (!plan.ops.length) {
    dbg('apply: no ops to execute');
    saveLastPush({ results });
    return { fields: plan.fields, results };
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

  saveLastPush({ results });
  dbg('apply done', { ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
  return { fields: plan.fields, results };
}

module.exports = { dryRun, apply };
