'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureDir: ensureLogDir, LOG_DIR } = require('./jobQueue');
const { getSkuFieldsPriority, pickSku } = require('./sku-fields');

const FILE_PATH = path.join(LOG_DIR, 'pending-inventory.json');
const TMP_PATH = `${FILE_PATH}.tmp`;
const BAK_PATH = `${FILE_PATH}.bak`;
const STORE_VERSION = 1;

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[pending-inventory] Failed to parse JSON', { file, error: err?.message || err });
    return null;
  }
}

function writeJsonAtomic(file, value) {
  ensureLogDir();
  const payload = JSON.stringify(value, null, 2);
  fs.writeFileSync(TMP_PATH, payload, 'utf8');
  fs.renameSync(TMP_PATH, file);
  try {
    fs.copyFileSync(file, BAK_PATH);
  } catch (err) {
    console.warn('[pending-inventory] Failed to refresh backup', { file, error: err?.message || err });
  }
}

function normalizeText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function buildSkuCandidates(item, fieldsPriority) {
  const set = new Set();
  const push = (value) => {
    const norm = normalizeText(value);
    if (norm) set.add(norm);
  };

  if (Array.isArray(fieldsPriority) && fieldsPriority.length > 0) {
    for (const field of fieldsPriority) {
      push(item?.[field]);
    }
  }

  push(item?.FullName || item?.Fullname);
  push(item?.Name);
  push(item?.ManufacturerPartNumber);
  push(item?.PartNumber);
  push(item?.BarCodeValue);
  push(pickSku(item, fieldsPriority));

  return Array.from(set);
}

function deriveIdentifiers(item, fieldsPriority) {
  const listRaw = item?.ListID ?? item?.ListId ?? null;
  const listId = normalizeText(listRaw);
  const skuValues = buildSkuCandidates(item, fieldsPriority);
  return { listId, skuValues };
}

function buildPrimaryKey(identifiers, item) {
  if (identifiers.listId) return `listid:${identifiers.listId}`;
  if (identifiers.skuValues && identifiers.skuValues.length > 0) {
    return `sku:${identifiers.skuValues[0].toLowerCase()}`;
  }
  const hash = crypto.createHash('sha1').update(JSON.stringify(item)).digest('hex');
  return `hash:${hash}`;
}

function loadEntries() {
  const payload = readJsonSafe(FILE_PATH) || readJsonSafe(BAK_PATH);
  if (!payload || !Array.isArray(payload.items)) {
    return [];
  }
  return payload.items;
}

function saveEntries(entries, { now }) {
  const nowIso = now.toISOString();
  const payload = {
    version: STORE_VERSION,
    updatedAt: nowIso,
    items: entries,
  };
  writeJsonAtomic(FILE_PATH, payload);
  return payload;
}

function syncPendingItems(items, { now = new Date() } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIso = nowDate.toISOString();
  const existing = loadEntries();
  const fieldsPriority = getSkuFieldsPriority();

  const byKey = new Map();
  const byListId = new Map();
  const bySku = new Map();

  for (const entry of existing) {
    if (!entry || typeof entry !== 'object') continue;
    byKey.set(entry.key, entry);
    if (entry.listId) {
      byListId.set(entry.listId, entry);
    }
    const skus = Array.isArray(entry.skuValues) ? entry.skuValues : [];
    for (const sku of skus) {
      const key = String(sku || '').toLowerCase();
      if (!key) continue;
      if (!bySku.has(key)) bySku.set(key, entry);
    }
  }

  const next = [];
  let added = 0;
  let reused = 0;

  const detachEntry = (entry) => {
    if (!entry) return;
    byKey.delete(entry.key);
    if (entry.listId) byListId.delete(entry.listId);
    const skus = Array.isArray(entry.skuValues) ? entry.skuValues : [];
    for (const sku of skus) {
      const key = String(sku || '').toLowerCase();
      if (!key) continue;
      if (bySku.get(key) === entry) bySku.delete(key);
    }
  };

  for (const item of Array.isArray(items) ? items : []) {
    const identifiers = deriveIdentifiers(item, fieldsPriority);
    let entry = null;

    if (identifiers.listId) {
      entry = byListId.get(identifiers.listId) || null;
    }

    if (!entry && identifiers.skuValues && identifiers.skuValues.length > 0) {
      for (const sku of identifiers.skuValues) {
        const found = bySku.get(sku.toLowerCase());
        if (found) {
          entry = found;
          break;
        }
      }
    }

    if (entry) {
      detachEntry(entry);
      entry.item = item;
      entry.lastSeenAt = nowIso;
      if (identifiers.listId && identifiers.listId !== entry.listId) {
        entry.listId = identifiers.listId;
      }
      const mergedSku = new Set();
      (entry.skuValues || []).forEach((sku) => {
        const norm = normalizeText(sku);
        if (norm) mergedSku.add(norm);
      });
      (identifiers.skuValues || []).forEach((sku) => {
        const norm = normalizeText(sku);
        if (norm) mergedSku.add(norm);
      });
      entry.skuValues = Array.from(mergedSku);
      next.push(entry);
      reused += 1;
    } else {
      const identifiersNew = deriveIdentifiers(item, fieldsPriority);
      const key = buildPrimaryKey(identifiersNew, item);
      entry = {
        key,
        item,
        listId: identifiersNew.listId || null,
        skuValues: identifiersNew.skuValues || [],
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        lastApplyAttempt: null,
        lastApplyResult: null,
      };
      next.push(entry);
      added += 1;
    }
  }

  const removed = byKey.size;
  const sorted = next.sort((a, b) => {
    const aFirst = a.firstSeenAt || '';
    const bFirst = b.firstSeenAt || '';
    if (aFirst === bFirst) return 0;
    return aFirst < bFirst ? -1 : 1;
  });

  saveEntries(sorted, { now: nowDate });

  return {
    entries: sorted,
    added,
    reused,
    removed,
  };
}

function recordApplyResults(results, { now = new Date() } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIso = nowDate.toISOString();
  const existing = loadEntries();
  if (!existing.length) {
    return { removed: 0, updated: 0, remaining: 0 };
  }

  const byListId = new Map();
  const bySku = new Map();

  const normalizeSku = (value) => {
    const norm = normalizeText(value);
    return norm ? norm.toLowerCase() : null;
  };

  for (const result of Array.isArray(results) ? results : []) {
    if (!result || typeof result !== 'object') continue;
    const listId = normalizeText(result.listId);
    const skuNorm = normalizeSku(result.sku);
    if (listId) byListId.set(listId, result);
    if (skuNorm) bySku.set(skuNorm, result);
  }

  let removed = 0;
  let updated = 0;
  const remaining = [];

  const consumeResult = (res, entry) => {
    const listId = normalizeText(res?.listId);
    const skuNorm = normalizeSku(res?.sku);
    if (listId) byListId.delete(listId);
    if (skuNorm) bySku.delete(skuNorm);
    if (Array.isArray(entry?.skuValues)) {
      for (const sku of entry.skuValues) {
        const norm = normalizeSku(sku);
        if (norm) bySku.delete(norm);
      }
    }
  };

  for (const entry of existing) {
    if (!entry || typeof entry !== 'object') continue;
    let matched = null;
    if (entry.listId) matched = byListId.get(entry.listId) || null;
    if (!matched && Array.isArray(entry.skuValues)) {
      for (const sku of entry.skuValues) {
        const norm = normalizeSku(sku);
        if (!norm) continue;
        const res = bySku.get(norm);
        if (res) {
          matched = res;
          break;
        }
      }
    }

    if (!matched) {
      remaining.push(entry);
      continue;
    }

    consumeResult(matched, entry);
    const ok = Boolean(matched.ok);
    const error = ok ? null : normalizeText(matched.error) || null;
    entry.lastApplyAttempt = nowIso;
    entry.lastApplyResult = { ok, error };

    if (ok) {
      removed += 1;
    } else {
      updated += 1;
      remaining.push(entry);
    }
  }

  if (removed > 0 || updated > 0) {
    saveEntries(remaining, { now: nowDate });
  }

  return { removed, updated, remaining: remaining.length };
}

function listPendingItems() {
  return loadEntries().map((entry) => entry.item);
}

module.exports = {
  loadEntries,
  listPendingItems,
  syncPendingItems,
  recordApplyResults,
};
