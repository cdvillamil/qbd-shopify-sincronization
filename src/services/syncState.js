'use strict';

// Estado persistente de la sincronización QBD -> Shopify.
//
// Sustituye a la lógica de "solo lo modificado hoy" (filterInventoryForToday /
// filterUnchangedSnapshotItems) por una reconciliación basada en diferencias:
// para cada ítem de QBD guardamos la última cantidad que Shopify tiene confirmada
// y solo se vuelve a empujar cuando QBD difiere de ese valor, o cuando el ítem
// quedó pendiente (unmatched / error) y venció su ventana de reintento.
//
// Archivo: <LOG_DIR>/shopify-sync-state.json
// Forma:
// {
//   "updatedAt": "ISO",
//   "byKey": {
//     "<ListID>": {
//       "sku": "RUBY LIGHT 6.5 V2" | null,
//       "qbdQty": 6,
//       "shopifyQty": 6 | null,
//       "status": "seed" | "ok" | "unmatched" | "error",
//       "attempts": 3,
//       "lastAttemptAt": "ISO" | null,
//       "lastError": "NO_MATCH" | null
//     }
//   }
// }

const fs = require('fs');
const path = require('path');
const { LOG_DIR, ensureDir } = require('./jobQueue');

const STATE_PATH = path.join(LOG_DIR, 'shopify-sync-state.json');
const STATE_TMP = `${STATE_PATH}.tmp`;
const STATE_BAK = `${STATE_PATH}.bak`;

function toPositiveMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Reintentos con backoff para no martillar la API de Shopify en cada poll (~5 min).
const UNMATCHED_RETRY_MS = toPositiveMs(process.env.SYNC_UNMATCHED_RETRY_MS, 6 * 60 * 60 * 1000); // 6 h
const ERROR_RETRY_MS = toPositiveMs(process.env.SYNC_ERROR_RETRY_MS, 15 * 60 * 1000); // 15 min
// Tope de ítems por corrida: evita una avalancha si el estado se corrompe/reinicia.
const MAX_SYNC_PER_RUN = Math.max(1, Math.floor(toPositiveMs(process.env.SYNC_MAX_PER_RUN, 500)));

function emptyState() {
  return { updatedAt: null, byKey: {} };
}

function readState() {
  for (const p of [STATE_PATH, STATE_BAK]) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf8');
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.byKey && typeof parsed.byKey === 'object') {
        return parsed;
      }
    } catch (err) {
      console.warn('[syncState] read error', { path: p, error: err?.message || err });
    }
  }
  return emptyState();
}

function writeState(state) {
  ensureDir();
  const payload = JSON.stringify(
    { updatedAt: new Date().toISOString(), byKey: state?.byKey || {} },
    null,
    2
  );
  try {
    if (fs.existsSync(STATE_PATH)) fs.copyFileSync(STATE_PATH, STATE_BAK);
  } catch (err) {
    console.warn('[syncState] backup failed', err?.message || err);
  }
  fs.writeFileSync(STATE_TMP, payload, 'utf8');
  fs.renameSync(STATE_TMP, STATE_PATH);
}

function resetState() {
  try {
    if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
    if (fs.existsSync(STATE_BAK)) fs.unlinkSync(STATE_BAK);
  } catch (err) {
    console.warn('[syncState] reset error', err?.message || err);
  }
}

function keyForItem(item) {
  if (!item) return null;
  if (item.ListID != null) return String(item.ListID);
  if (item.ListId != null) return String(item.ListId);
  return null;
}

// Cantidad "objetivo" para Shopify, con el mismo clamp que usa el push real.
function qtyOf(item) {
  const n = Number(item?.QuantityOnHand);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, n);
}

function isEmptyState(state) {
  return !state || !state.byKey || Object.keys(state.byKey).length === 0;
}

// Primera corrida: registra las cantidades actuales de QBD como línea base
// SIN empujar nada a Shopify. A partir de aquí solo se sincronizan diferencias.
function seedFromCatalog(items) {
  const state = emptyState();
  const seededAt = new Date().toISOString();
  for (const item of Array.isArray(items) ? items : []) {
    const key = keyForItem(item);
    if (!key) continue;
    state.byKey[key] = {
      sku: null,
      qbdQty: qtyOf(item),
      shopifyQty: qtyOf(item), // asumido alineado hasta que /debug/drift o un cambio demuestren lo contrario
      status: 'seed',
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      seededAt,
    };
  }
  writeState(state);
  return state;
}

/**
 * Decide qué ítems del catálogo completo de QBD hay que empujar a Shopify.
 * @param {Array} allItems  parseInventoryFromQBXML(...).items (catálogo completo)
 * @returns {{ toSync: Array, reason: string, stateSize: number, catalogSize: number, capped: boolean }}
 */
function selectItemsToSync(allItems, { now = Date.now() } = {}) {
  const items = Array.isArray(allItems) ? allItems : [];
  const state = readState();

  if (isEmptyState(state)) {
    const seeded = seedFromCatalog(items);
    return {
      toSync: [],
      reason: 'seed',
      stateSize: Object.keys(seeded.byKey).length,
      catalogSize: items.length,
      capped: false,
    };
  }

  const picked = [];
  for (const item of items) {
    const key = keyForItem(item);
    if (!key) continue;
    const q = qtyOf(item);
    if (q == null) continue;

    const entry = state.byKey[key];
    if (!entry) {
      picked.push(item); // ítem nuevo que no estaba en el seed
      continue;
    }

    if (entry.status === 'ok' || entry.status === 'seed') {
      if (entry.shopifyQty !== q) picked.push(item);
      continue;
    }

    // unmatched / error -> reintentar si cambió la cantidad o venció el backoff
    const wait = entry.status === 'unmatched' ? UNMATCHED_RETRY_MS : ERROR_RETRY_MS;
    const last = Date.parse(entry.lastAttemptAt || '') || 0;
    if (entry.qbdQty !== q || now - last >= wait) picked.push(item);
  }

  const capped = picked.length > MAX_SYNC_PER_RUN;
  return {
    toSync: capped ? picked.slice(0, MAX_SYNC_PER_RUN) : picked,
    reason: 'diff',
    stateSize: Object.keys(state.byKey).length,
    catalogSize: items.length,
    capped,
  };
}

/**
 * Actualiza el estado con el resultado de un apply().
 * @param {Array} results  results de shopify.sync.apply() (con listId, sku, target, ok, error)
 * @returns {{ ok:number, unmatched:number, error:number, unmatchedItems:Array }}
 */
function recordResults(results) {
  const state = readState();
  const nowIso = new Date().toISOString();
  const summary = { ok: 0, unmatched: 0, error: 0 };

  for (const r of Array.isArray(results) ? results : []) {
    const key = r?.listId != null ? String(r.listId) : null;
    if (!key) continue;
    const prev = state.byKey[key] || { attempts: 0 };

    if (r.ok) {
      state.byKey[key] = {
        sku: r.sku ?? prev.sku ?? null,
        qbdQty: r.target,
        shopifyQty: r.target,
        status: 'ok',
        attempts: (prev.attempts || 0) + 1,
        lastAttemptAt: nowIso,
        lastError: null,
      };
      summary.ok += 1;
    } else {
      const status = r.error === 'NO_MATCH' ? 'unmatched' : 'error';
      state.byKey[key] = {
        sku: r.sku ?? prev.sku ?? null,
        qbdQty: r.target,
        shopifyQty: prev.shopifyQty ?? null,
        status,
        attempts: (prev.attempts || 0) + 1,
        lastAttemptAt: nowIso,
        lastError: r.error || null,
        candidates: Array.isArray(r.candidates) && r.candidates.length ? r.candidates : (prev.candidates || null),
      };
      summary[status] += 1;
    }
  }

  writeState(state);

  const unmatchedItems = Object.entries(state.byKey)
    .filter(([, v]) => v.status === 'unmatched')
    .map(([listId, v]) => ({
      listId,
      sku: v.sku,
      qbdQty: v.qbdQty,
      attempts: v.attempts,
      lastAttemptAt: v.lastAttemptAt,
      lastError: v.lastError,
      shopifyCandidates: v.candidates || null,
    }));

  summary.unmatchedItems = unmatchedItems;
  return summary;
}

module.exports = {
  STATE_PATH,
  readState,
  writeState,
  resetState,
  seedFromCatalog,
  selectItemsToSync,
  recordResults,
  keyForItem,
  qtyOf,
  UNMATCHED_RETRY_MS,
  ERROR_RETRY_MS,
  MAX_SYNC_PER_RUN,
};
