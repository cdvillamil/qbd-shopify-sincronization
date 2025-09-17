'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_DIR = '/tmp';
const FILE_NAME = 'pending-shopify-adjustments.json';

function resolveLogDir() {
  const dir = (process.env.LOG_DIR || DEFAULT_LOG_DIR).trim() || DEFAULT_LOG_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function filePath() {
  return path.join(resolveLogDir(), FILE_NAME);
}

function loadFile() {
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

function saveFile(entries) {
  const payload = {
    updatedAt: new Date().toISOString(),
    entries: Array.isArray(entries) ? entries : [],
  };
  fs.writeFileSync(filePath(), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function normalizeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function sameSku(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function cleanObject(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

function normalizeEntry(entry, jobId, nowIso) {
  const sku = String(entry?.sku || '').trim();
  if (!sku) return null;
  const normalized = {
    sku,
    jobId: entry?.jobId || jobId || null,
    source: entry?.source || 'unknown',
    delta: normalizeNumber(entry?.delta),
    available: normalizeNumber(entry?.available),
    qbdQoh: normalizeNumber(entry?.qbdQoh),
    target: normalizeNumber(entry?.target),
    inventory_item_id: entry?.inventory_item_id || null,
    note: entry?.note,
    createdAt: entry?.createdAt || nowIso,
  };
  return cleanObject(normalized);
}

function loadPendingAdjustments() {
  return loadFile();
}

function listPendingEntries() {
  return loadFile().entries;
}

function trackPendingAdjustments(jobId, entries = []) {
  const { entries: current } = loadFile();
  const nowIso = new Date().toISOString();
  const additions = [];

  for (const entry of Array.isArray(entries) ? entries : []) {
    const normalized = normalizeEntry(entry, jobId, nowIso);
    if (!normalized) continue;
    additions.push(normalized);
  }

  if (additions.length === 0) {
    return { updatedAt: null, entries: current };
  }

  const filtered = current.filter((existing) => !additions.some((add) => sameSku(existing?.sku, add?.sku)));
  const merged = [...filtered, ...additions];
  return saveFile(merged);
}

function clearPendingByJobId(jobId) {
  if (!jobId) return loadFile();
  const { entries } = loadFile();
  const filtered = entries.filter((entry) => entry?.jobId !== jobId);
  return saveFile(filtered);
}

function clearPendingBySkus(skus = []) {
  const targets = (Array.isArray(skus) ? skus : []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!targets.length) return loadFile();
  const { entries } = loadFile();
  const filtered = entries.filter((entry) => !targets.some((sku) => sameSku(entry?.sku, sku)));
  return saveFile(filtered);
}

function pendingSkuSet() {
  const set = new Set();
  for (const entry of listPendingEntries()) {
    const sku = String(entry?.sku || '').trim().toLowerCase();
    if (sku) set.add(sku);
  }
  return set;
}

module.exports = {
  loadPendingAdjustments,
  listPendingEntries,
  trackPendingAdjustments,
  clearPendingByJobId,
  clearPendingBySkus,
  pendingSkuSet,
};
