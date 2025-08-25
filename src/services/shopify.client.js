// src/services/shopify.client.js
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-01';
const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const LOCATION_ID = process.env.SHOPIFY_LOCATION_ID;

function base() {
  if (!STORE || !TOKEN) throw new Error('Faltan SHOPIFY_STORE / SHOPIFY_TOKEN');
  return `https://${STORE}/admin/api/${API_VERSION}`;
}

async function shopifyFetch(path, method='GET', body) {
  const url = `${base()}${path}`;
  const opts = {
    method,
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(()=> '');
    throw new Error(`Shopify ${method} ${path} -> ${res.status} ${text}`);
  }
  const ct = res.headers.get('content-type')||'';
  return ct.includes('application/json') ? res.json() : res.text();
}

async function findVariantBySKU(sku) {
  const q = encodeURIComponent(sku);
  const data = await shopifyFetch(`/variants.json?sku=${q}`, 'GET');
  const v = (data.variants || [])[0];
  if (!v) return null;
  return {
    id: v.id,
    sku: v.sku,
    product_id: v.product_id,
    inventory_item_id: v.inventory_item_id,
    title: v.title,
  };
}

async function getInventoryItemSku(inventory_item_id) {
  const data = await shopifyFetch(`/inventory_items/${inventory_item_id}.json`, 'GET');
  return data?.inventory_item?.sku || null;
}

// Set absoluto del nivel de inventario
async function setInventoryLevel(inventory_item_id, available, locationId = LOCATION_ID) {
  if (!locationId) throw new Error('Falta SHOPIFY_LOCATION_ID');
  const payload = { inventory_item_id, location_id: Number(locationId), available: Number(available) };
  return shopifyFetch('/inventory_levels/set.json', 'POST', payload);
}

// al final del archivo, agrega:
async function listLocations() {
  // REST: GET /admin/api/{version}/locations.json
  const data = await shopifyFetch('/locations.json', 'GET');
  return data?.locations || [];
}

module.exports = { findVariantBySKU, getInventoryItemSku, setInventoryLevel, listLocations };