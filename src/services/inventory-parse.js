// src/services/inventory-parse.js
// Parser muy simple (sin dependencias) para ItemInventoryRet → JSON
// y persistencia en /tmp/last-inventory.json

const fs = require('fs');

const INVENTORY_PATH = process.env.INVENTORY_PATH || '/tmp/last-inventory.json';

function extractInventoryItems(xml) {
  if (!xml || typeof xml !== 'string') return [];
  // Toma cada bloque <ItemInventoryRet>...</ItemInventoryRet>
  const blocks = xml.match(/<ItemInventoryRet[\s\S]*?<\/ItemInventoryRet>/g) || [];

  const pick = (src, tag) => {
    const m = src.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1] : '';
  };
  const toNum  = (v) => (v === '' || v == null ? null : Number(v));
  const toBool = (v) => String(v).toLowerCase() === 'true';

  return blocks.map(b => ({
    ListID: pick(b,'ListID') || null,
    Name: pick(b,'Name') || null,
    FullName: pick(b,'FullName') || null,
    IsActive: toBool(pick(b,'IsActive')),
    BarCodeValue: pick(b,'BarCodeValue') || null,
    ManufacturerPartNumber: pick(b,'ManufacturerPartNumber') || null,

    SalesDesc: pick(b,'SalesDesc') || null,
    SalesPrice: toNum(pick(b,'SalesPrice')),
    PurchaseDesc: pick(b,'PurchaseDesc') || null,
    PurchaseCost: toNum(pick(b,'PurchaseCost')),

    QuantityOnHand: toNum(pick(b,'QuantityOnHand')),
    AverageCost: toNum(pick(b,'AverageCost')),
    QuantityOnOrder: toNum(pick(b,'QuantityOnOrder')),
    QuantityOnSalesOrder: toNum(pick(b,'QuantityOnSalesOrder')),
  }));
}

function saveInventoryJson(items) {
  const payload = {
    updatedAt: new Date().toISOString(),
    count: items.length,
    items,
  };
  fs.writeFileSync(INVENTORY_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function parseAndPersistInventory(xml) {
  const items = extractInventoryItems(xml);
  return saveInventoryJson(items);
}

module.exports = {
  INVENTORY_PATH,
  extractInventoryItems,
  parseAndPersistInventory,
};
