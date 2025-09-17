'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_DIR = '/tmp';
const FILE_NAME = 'shopify-inventory-item-map.json';

function resolveLogDir() {
  const dir = (process.env.LOG_DIR || DEFAULT_LOG_DIR).trim() || DEFAULT_LOG_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function filePath() {
  return path.join(resolveLogDir(), FILE_NAME);
}

function readFile() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return { updatedAt: null, entries: parsed };
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    const updatedAt = parsed && typeof parsed === 'object' ? parsed.updatedAt || null : null;
    return { updatedAt, entries };
  } catch {
    return { updatedAt: null, entries: [] };
  }
}

function saveFile(entries, updatedAt) {
  const payload = {
    updatedAt: updatedAt || new Date().toISOString(),
    entries: Array.isArray(entries) ? entries : [],
  };
  fs.writeFileSync(filePath(), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function normalizeId(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(/(\d+)$/);
  return match ? match[1] : raw;
}

function normalizeSku(value) {
  const sku = String(value || '').trim();
  return sku || null;
}

function extractInventoryItemIdFromGraphId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const paramMatch = raw.match(/inventory_item_id=(\d+)/i);
  if (paramMatch) return paramMatch[1];
  const gidMatch = raw.match(/InventoryItem\/(\d+)/i);
  if (gidMatch) return gidMatch[1];
  return null;
}

function normalizeEntry(entry, nowIso) {
  const inventoryItemId = normalizeId(
    entry?.inventory_item_id ??
    entry?.inventoryItemId ??
    entry?.inventory_item?.id ??
    entry?.inventory_item?.inventoryItemId ??
    entry?.inventoryItem?.id ??
    extractInventoryItemIdFromGraphId(entry?.admin_graphql_api_id)
  );
  const sku = normalizeSku(entry?.sku ?? entry?.SKU ?? entry?.Sku);
  if (!inventoryItemId || !sku) return null;

  const variantId = normalizeId(entry?.variant_id ?? entry?.variantId ?? entry?.variant?.id);
  const normalized = {
    inventory_item_id: inventoryItemId,
    sku,
  };
  if (variantId) normalized.variant_id = variantId;
  if (entry?.source) normalized.source = entry.source;
  normalized.updatedAt = entry?.updatedAt || nowIso;
  return normalized;
}

function mergeEntry(existing, addition, nowIso) {
  if (!existing) return { ...addition, updatedAt: addition.updatedAt || nowIso };
  const merged = { ...existing };
  if (addition.sku) merged.sku = addition.sku;
  if (addition.variant_id) merged.variant_id = addition.variant_id;
  if (addition.source) merged.source = addition.source;
  merged.updatedAt = addition.updatedAt || nowIso;
  return merged;
}

function rememberInventoryItems(items = []) {
  const source = readFile();
  const entries = Array.isArray(source.entries) ? [...source.entries] : [];
  const nowIso = new Date().toISOString();
  const map = new Map(entries.map((e) => [normalizeId(e?.inventory_item_id), e]));
  let touched = false;

  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeEntry(item, nowIso);
    if (!normalized) continue;
    const key = normalizeId(normalized.inventory_item_id);
    if (!key) continue;

    const current = map.get(key) || null;
    const merged = mergeEntry(current, normalized, nowIso);
    const changed = !current
      || current.sku !== merged.sku
      || current.variant_id !== merged.variant_id
      || current.source !== merged.source
      || current.updatedAt !== merged.updatedAt;
    if (changed) {
      map.set(key, merged);
      touched = true;
    }
  }

  if (!touched) return source;

  const nextEntries = Array.from(map.values())
    .filter((entry) => normalizeId(entry?.inventory_item_id) && normalizeSku(entry?.sku))
    .map((entry) => ({
      inventory_item_id: normalizeId(entry.inventory_item_id),
      sku: entry.sku,
      variant_id: normalizeId(entry.variant_id) || undefined,
      source: entry.source || undefined,
      updatedAt: entry.updatedAt || nowIso,
    }));

  return saveFile(nextEntries, nowIso);
}

function resolveInventoryItem(inventoryItemId) {
  const key = normalizeId(inventoryItemId);
  if (!key) return null;
  const { entries } = readFile();
  return (entries || []).find((entry) => normalizeId(entry?.inventory_item_id) === key) || null;
}

function resolveInventoryItemSku(inventoryItemId) {
  const resolved = resolveInventoryItem(inventoryItemId);
  return resolved ? resolved.sku : null;
}

function resolveInventoryItemIdBySku(sku) {
  const target = normalizeSku(sku);
  if (!target) return null;
  const { entries } = readFile();
  const found = (entries || []).find((entry) => normalizeSku(entry?.sku) === target);
  return found ? normalizeId(found.inventory_item_id) : null;
}

module.exports = {
  rememberInventoryItems,
  resolveInventoryItem,
  resolveInventoryItemSku,
  resolveInventoryItemIdBySku,
};
