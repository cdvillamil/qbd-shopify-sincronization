// src/services/sku-map.js
const fs = require('fs');
const path = require('path');

const TMP_DIR = '/tmp';
const OVERRIDES_PATH = path.join(TMP_DIR, 'sku-overrides.json');

function loadOverrides() {
  try {
    if (!fs.existsSync(OVERRIDES_PATH)) return { updatedAt: null, items: [] };
    const json = JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
    return json && Array.isArray(json.items) ? json : { updatedAt: null, items: [] };
  } catch { return { updatedAt: null, items: [] }; }
}
function saveOverrides(list) {
  const payload = { updatedAt: new Date().toISOString(), items: list };
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function resolveSkuToItem(qbdItems, sku, fieldsPriority = []) {
  if (!sku) return null;
  const skuLc = String(sku).trim().toLowerCase();
  if (!skuLc) return null;

  const { items: overrides } = loadOverrides();
  const ov = overrides.find(o => String(o.sku || '').trim().toLowerCase() === skuLc);
  if (ov) {
    if (ov.ListID)  return qbdItems.find(x => x.ListID === ov.ListID) || null;
    if (ov.FullName) return qbdItems.find(x => (x.FullName || '').toLowerCase() === ov.FullName.toLowerCase()) || null;
    if (ov.Name)     return qbdItems.find(x => (x.Name || '').toLowerCase() === ov.Name.toLowerCase()) || null;
  }

  for (const f of fieldsPriority) {
    const it = qbdItems.find(x => String(x[f] || '').trim().toLowerCase() === skuLc);
    if (it) return it;
  }
  return null;
}

module.exports = { loadOverrides, saveOverrides, resolveSkuToItem };