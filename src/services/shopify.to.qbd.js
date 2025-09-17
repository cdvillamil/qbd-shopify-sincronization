'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { resolveSkuToItem } = require('./sku-map');
const { enqueue, prioritizeJobs } = require('./jobQueue');
const { pendingSkuSet, trackPendingAdjustments } = require('./pendingAdjustments');
const {
  rememberInventoryItems,
  resolveInventoryItemSku,
} = require('./inventoryItemMap');
const {
  findVariantByInventoryItemId,
  getInventoryItemSku,
} = require('./shopify.client');
const { loadInventorySnapshot } = require('./qbd.inventorySnapshot');

const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-01';
const STORE = process.env.SHOPIFY_STORE;
const TOKEN = process.env.SHOPIFY_TOKEN;
const LOCATION_ID = process.env.SHOPIFY_LOCATION_ID
  ? String(process.env.SHOPIFY_LOCATION_ID).trim()
  : null;

const LOG_DIR = (process.env.LOG_DIR || '/tmp').trim() || '/tmp';
const LAST_PLAN_PATH = path.join(LOG_DIR, 'shopify-to-qbd-last-plan.json');
const LAST_RESULT_PATH = path.join(LOG_DIR, 'shopify-to-qbd-last-result.json');

let autoTimer = null;
let autoRunning = false;

function ensureLogDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function baseUrl() {
  if (!STORE || !TOKEN) {
    throw new Error('Missing SHOPIFY_STORE / SHOPIFY_TOKEN environment variables');
  }
  return `https://${STORE}/admin/api/${API_VERSION}`;
}

function hasShopifyConfig() {
  return Boolean(STORE && TOKEN);
}

function skuFields() {
  const env = process.env.QBD_SKU_FIELDS || process.env.QBD_SKU_FIELD || 'Name';
  return env.split(',').map((s) => s.trim()).filter(Boolean);
}

function getTodayRange(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function parseDate(value) {
  const dt = value instanceof Date ? value : new Date(value);
  return Number.isNaN(dt.valueOf()) ? null : dt;
}

function toIso(dt) {
  const d = parseDate(dt);
  return d ? d.toISOString() : null;
}

function extractNextPage(linkHeader) {
  if (!linkHeader) return null;
  const parts = String(linkHeader)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  for (const part of parts) {
    const [urlPart, relPart] = part.split(';').map((s) => s.trim());
    if (!relPart || !/rel="next"/i.test(relPart)) continue;
    const urlMatch = urlPart.match(/<([^>]+)>/);
    const url = urlMatch ? urlMatch[1] : null;
    if (!url) continue;
    try {
      const u = new URL(url);
      const pageInfo = u.searchParams.get('page_info');
      if (pageInfo) return pageInfo;
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchInventoryLevels({
  updatedAtMin,
  pageInfo,
  limit = 250,
  locationId = LOCATION_ID,
} = {}) {
  const url = new URL(`${baseUrl()}/inventory_levels.json`);
  url.searchParams.set('limit', String(limit));

  if (pageInfo) {
    url.searchParams.set('page_info', pageInfo);
  } else {
    const iso = toIso(updatedAtMin);
    if (iso) {
      url.searchParams.set('updated_at_min', iso);
    }
    if (locationId) {
      url.searchParams.set('location_ids', String(locationId));
    }
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Shopify GET ${url.pathname} -> ${res.status} ${text}`);
  }

  const data = await res.json().catch(() => ({}));
  const levels = Array.isArray(data?.inventory_levels) ? data.inventory_levels : [];
  const nextPageInfo = extractNextPage(res.headers.get('link'));

  return { levels, nextPageInfo };
}

async function listInventoryLevelsSince(startDate, { locationId = LOCATION_ID } = {}) {
  const start = parseDate(startDate);
  if (!start) return [];

  const out = [];
  let pageInfo = null;
  let safety = 0;

  do {
    // Según la documentación, cuando usamos page_info solo se debe enviar limit
    const batch = await fetchInventoryLevels({
      updatedAtMin: pageInfo ? undefined : start,
      pageInfo,
      locationId,
    });
    out.push(...batch.levels);
    pageInfo = batch.nextPageInfo || null;
    safety += 1;
    if (safety > 200) {
      throw new Error('Shopify inventory pagination safety stop triggered');
    }
  } while (pageInfo);

  return out;
}

function rememberAll(entries = []) {
  if (!Array.isArray(entries) || !entries.length) return;
  try { rememberInventoryItems(entries); }
  catch (err) { console.error('[shopify->qbd] rememberInventoryItems error:', err); }
}

async function resolveSkuForInventoryItem(inventoryItemId) {
  const cached = resolveInventoryItemSku(inventoryItemId);
  if (cached) return { sku: cached, remembered: false };

  const rememberEntries = [];

  try {
    const variant = await findVariantByInventoryItemId(inventoryItemId).catch(() => null);
    if (variant?.sku) {
      rememberEntries.push({
        sku: variant.sku,
        inventory_item_id: inventoryItemId,
        variant_id: variant.id,
        source: 'shopify-sync-lookup',
      });
      rememberAll(rememberEntries);
      return { sku: variant.sku, remembered: true };
    }
  } catch (err) {
    console.error('[shopify->qbd] findVariantByInventoryItemId error:', err);
  }

  try {
    const fallback = await getInventoryItemSku(inventoryItemId).catch(() => null);
    if (fallback) {
      rememberEntries.push({
        sku: fallback,
        inventory_item_id: inventoryItemId,
        source: 'shopify-sync-inventory-item',
      });
      rememberAll(rememberEntries);
      return { sku: fallback, remembered: true };
    }
  } catch (err) {
    console.error('[shopify->qbd] getInventoryItemSku error:', err);
  }

  if (rememberEntries.length) rememberAll(rememberEntries);
  return { sku: null, remembered: false };
}

function normalizeInventoryLevels(levels = [], { start, end }) {
  const dedup = new Map();
  for (const level of Array.isArray(levels) ? levels : []) {
    const updatedAt = parseDate(level?.updated_at);
    if (!updatedAt || (start && updatedAt < start) || (end && updatedAt >= end)) {
      continue;
    }
    const key = String(level?.inventory_item_id || '').trim();
    if (!key) continue;
    const stamp = updatedAt.valueOf();
    const existing = dedup.get(key);
    if (!existing || existing.updatedAt < stamp) {
      dedup.set(key, {
        inventory_item_id: key,
        location_id: level?.location_id,
        available: Number(level?.available),
        updated_at: updatedAt.toISOString(),
        raw: level,
        updatedAt: stamp,
      });
    }
  }
  return Array.from(dedup.values());
}

function prioritizeShopifyAdjustments() {
  try {
    prioritizeJobs((job) => {
      if (!job || job.type !== 'inventoryAdjust') return false;
      const source = String(job.source || '').toLowerCase();
      return source.startsWith('shopify-');
    });
  } catch (err) {
    console.error('[shopify->qbd] prioritizeJobs error:', err);
  }
}

function aggregateAdjustments(entries = []) {
  const aggregated = new Map();
  for (const entry of entries) {
    if (!entry) continue;
    const key = entry.listId
      ? `id:${entry.listId}`
      : `name:${String(entry.fullName || entry.sku || '').trim().toLowerCase()}`;
    if (!key) continue;

    const current = aggregated.get(key) || {
      listId: entry.listId || null,
      fullName: entry.fullName || null,
      delta: 0,
      members: [],
    };
    current.delta += entry.delta;
    current.members.push(entry);
    aggregated.set(key, current);
  }

  const lines = [];
  for (const group of aggregated.values()) {
    if (!group.delta) continue;
    if (group.listId) {
      lines.push({ ListID: group.listId, QuantityDifference: group.delta });
    } else if (group.fullName) {
      lines.push({ FullName: group.fullName, QuantityDifference: group.delta });
    }
  }
  return { aggregated: Array.from(aggregated.values()), lines };
}

function describeSkip(reason, meta) {
  return { reason, ...meta };
}

async function planShopifyAdjustments(options = {}) {
  if (!hasShopifyConfig()) {
    throw new Error('Shopify credentials are required to plan adjustments');
  }
  const now = options.now instanceof Date ? options.now : new Date();
  const { start, end } = options.start && options.end
    ? { start: parseDate(options.start), end: parseDate(options.end) }
    : getTodayRange(now);

  const locationId = options.locationId || LOCATION_ID || null;

  const levels = await listInventoryLevelsSince(start, { locationId });
  const normalizedLevels = normalizeInventoryLevels(levels, { start, end });

  const inventory = loadInventorySnapshot();
  const fields = skuFields();
  const pending = pendingSkuSet();

  const adjustments = [];
  const skipped = [];
  const unmatched = [];

  for (const level of normalizedLevels) {
    const available = Number(level.available);
    if (!Number.isFinite(available)) {
      skipped.push(describeSkip('INVALID_AVAILABLE', { inventory_item_id: level.inventory_item_id }));
      continue;
    }

    const resolved = await resolveSkuForInventoryItem(level.inventory_item_id);
    const sku = String(resolved?.sku || '').trim();
    if (!sku) {
      unmatched.push({ inventory_item_id: level.inventory_item_id, reason: 'NO_SKU' });
      continue;
    }

    const skuLc = sku.toLowerCase();
    if (pending.has(skuLc)) {
      skipped.push(describeSkip('PENDING_SHOPIFY_JOB', { sku }));
      continue;
    }

    const item = resolveSkuToItem(inventory.items || [], sku, fields);
    if (!item) {
      unmatched.push({ sku, inventory_item_id: level.inventory_item_id, reason: 'NO_QBD_MATCH' });
      continue;
    }

    const qbdQoh = Number(item.QuantityOnHand || 0);
    const delta = available - qbdQoh;
    if (!delta) {
      skipped.push(describeSkip('NO_DELTA', { sku }));
      continue;
    }

    adjustments.push({
      sku,
      inventory_item_id: level.inventory_item_id,
      available,
      qbdQoh,
      delta,
      target: available,
      listId: item.ListID || null,
      fullName: item.FullName || item.Name || sku,
      updated_at: level.updated_at,
      location_id: level.location_id || locationId,
      source: 'shopify-bulk-sync',
    });
  }

  const { lines } = aggregateAdjustments(adjustments);

  const payload = {
    generatedAt: now.toISOString(),
    window: {
      start: start ? start.toISOString() : null,
      endExclusive: end ? end.toISOString() : null,
    },
    locationId,
    counts: {
      fetchedLevels: levels.length,
      consideredLevels: normalizedLevels.length,
      adjustments: adjustments.length,
      lines: lines.length,
      pendingSkus: pending.size,
    },
    adjustments,
    skipped: skipped.slice(0, 200),
    unmatched: unmatched.slice(0, 200),
    snapshotSummary: {
      items: Array.isArray(inventory.items) ? inventory.items.length : 0,
      filteredItems: Array.isArray(inventory.filteredItems) ? inventory.filteredItems.length : 0,
    },
  };

  return payload;
}

function saveJson(file, data) {
  try {
    ensureLogDir();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[shopify->qbd] saveJson error:', err);
  }
}

function createJobId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
}

async function applyShopifyAdjustments(options = {}) {
  if (!hasShopifyConfig()) {
    throw new Error('Shopify credentials are required to apply adjustments');
  }
  const plan = await planShopifyAdjustments(options);
  saveJson(LAST_PLAN_PATH, plan);

  if (!plan.adjustments.length || !plan.counts.lines) {
    const result = {
      applied: false,
      queuedLines: 0,
      queuedSkus: 0,
      jobId: null,
      plan,
      executedAt: new Date().toISOString(),
      reason: 'NO_CHANGES',
    };
    saveJson(LAST_RESULT_PATH, result);
    return result;
  }

  const lines = [];
  const aggregated = aggregateAdjustments(plan.adjustments);
  lines.push(...aggregated.lines);

  if (!lines.length) {
    const result = {
      applied: false,
      queuedLines: 0,
      queuedSkus: 0,
      jobId: null,
      plan,
      executedAt: new Date().toISOString(),
      reason: 'NO_LINES',
    };
    saveJson(LAST_RESULT_PATH, result);
    return result;
  }

  const jobId = createJobId();
  const job = {
    id: jobId,
    type: 'inventoryAdjust',
    lines,
    account: process.env.QBD_ADJUST_ACCOUNT || undefined,
    source: 'shopify-bulk-sync',
    createdAt: new Date().toISOString(),
    skus: plan.adjustments.map((a) => a.sku).filter(Boolean),
    pendingAdjustments: plan.adjustments,
  };

  enqueue(job);
  prioritizeShopifyAdjustments();
  trackPendingAdjustments(jobId, plan.adjustments);

  const result = {
    applied: true,
    queuedLines: lines.length,
    queuedSkus: plan.adjustments.length,
    jobId,
    plan,
    queuedAt: new Date().toISOString(),
  };
  saveJson(LAST_RESULT_PATH, result);
  return result;
}

function parseIntervalMs() {
  const raw = Number(process.env.SHOPIFY_TO_QBD_INTERVAL_SEC || '300');
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw * 1000);
}

function autoSyncEnabled() {
  const raw = process.env.SHOPIFY_TO_QBD_AUTO_SYNC;
  if (raw == null || raw === '') return true;
  return /^(1|true|yes)$/i.test(String(raw));
}

function startAutoSync() {
  if (!autoSyncEnabled()) return { enabled: false, reason: 'disabled' };
  if (!hasShopifyConfig()) return { enabled: false, reason: 'missing_shopify_config' };
  const intervalMs = parseIntervalMs();
  if (!intervalMs) return { enabled: false, reason: 'invalid_interval' };
  if (autoTimer) return { enabled: true, intervalMs, alreadyRunning: true };

  const run = async () => {
    if (autoRunning) return;
    autoRunning = true;
    try {
      const result = await applyShopifyAdjustments({ reason: 'auto' });
      if (result?.applied) {
        console.log('[shopify->qbd] auto sync queued', {
          lines: result.queuedLines,
          skus: result.queuedSkus,
          jobId: result.jobId,
        });
      }
    } catch (err) {
      console.error('[shopify->qbd] auto sync error:', err);
    } finally {
      autoRunning = false;
    }
  };

  autoTimer = setInterval(() => {
    run().catch((err) => console.error('[shopify->qbd] auto sync tick error:', err));
  }, intervalMs);
  if (typeof autoTimer.unref === 'function') autoTimer.unref();

  const immediate = process.env.SHOPIFY_TO_QBD_AUTO_SYNC_IMMEDIATE;
  const shouldRunNow = immediate == null || immediate === '' || /^(1|true|yes)$/i.test(String(immediate));
  if (shouldRunNow) {
    setTimeout(() => run().catch((err) => console.error('[shopify->qbd] initial auto sync error:', err)), 1000);
  }

  console.log('[shopify->qbd] auto sync scheduled every', intervalMs / 1000, 'seconds');
  return { enabled: true, intervalMs };
}

module.exports = {
  planShopifyAdjustments,
  applyShopifyAdjustments,
  startAutoSync,
};
