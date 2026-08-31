'use strict';

// Verificación manual de la Fase 3 (runReconcile) con Shopify simulado vía
// global.fetch. Uso:  node scripts/verify-reconcile.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
process.env.LOG_DIR = TMP;
process.env.SHOPIFY_STORE = 'test.myshopify.com';
process.env.SHOPIFY_TOKEN = 'shpat_test';
process.env.SHOPIFY_API_VERSION = '2025-10';
process.env.SHOPIFY_LOCATION_ID = '68011262199';
process.env.SHOPIFY_REST_MIN_INTERVAL_MS = '0';
process.env.SHOPIFY_RECONCILE_ENABLED = 'true';

// Catálogo QBD
fs.writeFileSync(path.join(TMP, 'last-inventory.json'), JSON.stringify({
  allItems: [
    { ListID: 'A', Name: 'ITEM-A', QuantityOnHand: 10 }, // en sync
    { ListID: 'B', Name: 'ITEM-B', QuantityOnHand: 5 },   // Shopify=2 -> fix
    { ListID: 'C', Name: 'ITEM-C', QuantityOnHand: 0 },   // Shopify=4 -> fix
    { ListID: 'Z', Name: 'ITEM-Z', QuantityOnHand: 7 },   // sin variante
  ],
}));

// Variantes de Shopify simuladas
const SHOP = {
  'ITEM-A': { inv: 111, available: 10 },
  'ITEM-B': { inv: 222, available: 2 },
  'ITEM-C': { inv: 333, available: 4 },
  'ITEM-X': { inv: 999, available: 1 }, // solo en Shopify
};
const setCalls = [];

global.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : {};
  if (String(url).includes('/graphql.json')) {
    const edges = Object.entries(SHOP).map(([sku, v]) => ({
      cursor: sku,
      node: {
        id: `gid://shopify/ProductVariant/${v.inv}0`,
        sku, title: sku,
        inventoryItem: {
          id: `gid://shopify/InventoryItem/${v.inv}`,
          sku,
          inventoryLevel: { quantities: [{ name: 'available', quantity: v.available }] },
        },
        product: { id: 'gid://shopify/Product/1', title: sku, handle: sku.toLowerCase() },
      },
    }));
    return { ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ data: { productVariants: { edges, pageInfo: { hasNextPage: false, endCursor: null } } } }) };
  }
  if (String(url).includes('/inventory_levels/set.json')) {
    setCalls.push({ inventory_item_id: body.inventory_item_id, available: body.available });
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ inventory_level: { available: body.available } }) };
  }
  throw new Error('unexpected fetch ' + url);
};

const { runReconcile } = require('../src/services/shopify.sync');
const { readState } = require('../src/services/syncState');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

(async () => {
  // 1) dry-run: no empuja
  let r = await runReconcile({ dryRun: true });
  assert(r.inSync === 1, `dry-run inSync=1 (${r.inSync})`);
  assert(r.diffsFound === 2, `dry-run diffsFound=2 (${r.diffsFound})`);
  assert(r.corrected === 0 && setCalls.length === 0, 'dry-run no empuja nada');
  assert(r.unmatched === 1, `dry-run unmatched=1 (${r.unmatched})`);

  // 2) real
  r = await runReconcile();
  assert(r.corrected === 2, `real corrected=2 (${r.corrected})`);
  assert(setCalls.length === 2, `2 llamadas setInventoryLevel (${setCalls.length})`);
  assert(setCalls.some(c => c.inventory_item_id === 222 && c.available === 5), 'B -> 5');
  assert(setCalls.some(c => c.inventory_item_id === 333 && c.available === 0), 'C -> 0');

  const st = readState().byKey;
  assert(st.A && st.A.status === 'ok' && st.A.shopifyQty === 10, 'A verificado ok=10');
  assert(st.B && st.B.status === 'ok' && st.B.shopifyQty === 5, 'B ok=5');
  assert(st.Z && st.Z.status === 'unmatched', 'Z unmatched');

  // 3) segunda corrida: ya todo en sync -> 0 correcciones
  setCalls.length = 0;
  // Reflejar en el mock que B y C ya quedaron corregidos
  SHOP['ITEM-B'].available = 5; SHOP['ITEM-C'].available = 0;
  r = await runReconcile();
  assert(r.diffsFound === 0 && setCalls.length === 0, 'segunda corrida sin diferencias');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failures === 0 ? '\nOK - todo verde' : `\n${failures} fallo(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
