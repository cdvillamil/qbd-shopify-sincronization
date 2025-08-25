// src/services/shopify.sync.js
const fs = require('fs');
const path = require('path');
const { findVariantBySKU, setInventoryLevel } = require('./shopify.client');

const TMP_DIR = '/tmp';
const SNAP_PATH = path.join(TMP_DIR, 'last-inventory.json');
const LAST_PUSH_PATH = path.join(TMP_DIR, 'shopify-last-pushed.json');

function getSkuFieldsPriority() {
  const env = process.env.QBD_SKU_FIELDS || process.env.QBD_SKU_FIELD || 'Name';
  return env.split(',').map(s => s.trim()).filter(Boolean);
}
function pickSku(it, fields) {
  for (const f of fields) {
    const v = (it[f] || '').trim();
    if (v) return v;
  }
  return null;
}

function loadSnapshot() {
  if (!fs.existsSync(SNAP_PATH)) return { items: [] };
  try { return JSON.parse(fs.readFileSync(SNAP_PATH,'utf8')) || {items:[]}; } catch { return {items:[]}; }
}
function saveLastPush(plan) {
  const payload = { pushedAt: new Date().toISOString(), ...plan };
  fs.writeFileSync(LAST_PUSH_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

async function dryRun(limit) {
  const { items } = loadSnapshot();
  const fields = getSkuFieldsPriority();
  const out = [];
  for (const it of items) {
    const sku = pickSku(it, fields);
    if (!sku) continue;
    const qty = Number(it.QuantityOnHand || 0);
    const variant = await findVariantBySKU(sku).catch(()=>null);
    out.push({
      sku,
      target: qty,
      inventory_item_id: variant?.inventory_item_id || null,
      action: variant ? 'SET_AVAILABLE' : 'NO_MATCH',
    });
    if (limit && out.length >= Number(limit)) break;
  }
  return { fields, ops: out };
}

async function apply(limit) {
  const plan = await dryRun(limit);
  const results = [];
  for (const op of plan.ops) {
    if (op.action !== 'SET_AVAILABLE' || !op.inventory_item_id) {
      results.push({ ...op, ok: false, error: 'NO_MATCH' });
      continue;
    }
    try {
      await setInventoryLevel(op.inventory_item_id, op.target);
      results.push({ ...op, ok: true });
    } catch (e) {
      results.push({ ...op, ok: false, error: String(e.message || e) });
    }
  }
  saveLastPush({ results });
  return { fields: plan.fields, results };
}

module.exports = { dryRun, apply };