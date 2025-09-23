// src/services/shopify.client.js
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-01';
const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const LOCATION_ID = process.env.SHOPIFY_LOCATION_ID;

function toMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function toInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

const MIN_INTERVAL_MS = toMs(process.env.SHOPIFY_REST_MIN_INTERVAL_MS, 600);
const MAX_RETRIES = toInt(process.env.SHOPIFY_REST_MAX_RETRIES, 5);
const RETRY_BASE_DELAY_MS = toMs(process.env.SHOPIFY_REST_RETRY_BASE_MS, 500);
const RETRY_MAX_DELAY_MS = toMs(process.env.SHOPIFY_REST_RETRY_MAX_MS, 15000);
const DEBUG_RETRIES = /^(1|true|yes)$/i.test(process.env.SHOPIFY_REST_DEBUG || '');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let queue = Promise.resolve();
let lastRequestTime = 0;

async function waitForTurn() {
  const now = Date.now();
  const wait = Math.max(0, (lastRequestTime + MIN_INTERVAL_MS) - now);
  if (wait > 0) await sleep(wait);
  lastRequestTime = Date.now();
}

function enqueue(task) {
  const run = queue.then(task);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

function parseRetryAfter(headerValue) {
  if (!headerValue) return null;

  const seconds = Number(headerValue);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryDate = Date.parse(headerValue);
  if (!Number.isNaN(retryDate)) {
    const diff = retryDate - Date.now();
    return diff > 0 ? diff : 0;
  }

  return null;
}

function logRetry(context, details) {
  if (!DEBUG_RETRIES) return;
  console.warn('[shopify.rest]', context, details);
}

function base() {
  if (!STORE || !TOKEN) throw new Error('Faltan SHOPIFY_STORE / SHOPIFY_TOKEN');
  return `https://${STORE}/admin/api/${API_VERSION}`;
}

async function shopifyFetch(path, method = 'GET', body) {
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
  return enqueue(async () => {
    let lastErrorText = '';

    for (let attempt = 1; attempt <= (MAX_RETRIES + 1); attempt += 1) {
      await waitForTurn();

      let res;
      try {
        res = await fetch(url, opts);
      } catch (err) {
        lastErrorText = String(err && err.message ? err.message : err);
        if (attempt > MAX_RETRIES) break;
        const delayMs = Math.min(RETRY_MAX_DELAY_MS, Math.max(RETRY_BASE_DELAY_MS, RETRY_BASE_DELAY_MS * attempt));
        logRetry('network error, retrying', { path, method, attempt, delayMs, error: lastErrorText });
        await sleep(delayMs);
        continue;
      }

      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        return ct.includes('application/json') ? res.json() : res.text();
      }

      const text = await res.text().catch(() => '');
      lastErrorText = text;

      const retryable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (retryable && attempt <= MAX_RETRIES) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterMs = parseRetryAfter(retryAfterHeader);
        const delayMs = Math.min(
          RETRY_MAX_DELAY_MS,
          Math.max(
            RETRY_BASE_DELAY_MS,
            retryAfterMs !== null ? retryAfterMs : RETRY_BASE_DELAY_MS * attempt
          )
        );
        const bodyPreview = text && text.length > 500 ? `${text.slice(0, 500)}…` : text;
        logRetry('retryable response', { path, method, status: res.status, attempt, delayMs, body: bodyPreview });
        await sleep(delayMs);
        continue;
      }

      throw new Error(`Shopify ${method} ${path} -> ${res.status} ${text}`);
    }

    throw new Error(`Shopify ${method} ${path} retry limit reached (${MAX_RETRIES + 1} attempts) ${lastErrorText}`);
  });
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
