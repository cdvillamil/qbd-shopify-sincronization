'use strict';

// Verificación manual (sin servidor / sin QBD / sin Shopify) de la lógica de
// reconciliación por diferencia. Uso:  node scripts/verify-sync-state.js
//
// Cubre: seed sin empujar, detección de diff, confirmación ok, reintento de
// unmatched con backoff, y el tope MAX_SYNC_PER_RUN.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syncstate-'));
process.env.LOG_DIR = TMP;
process.env.SYNC_UNMATCHED_RETRY_MS = '1000'; // 1 s para poder probar el backoff
process.env.SYNC_MAX_PER_RUN = '3';

const { selectItemsToSync, recordResults, readState, resetState } = require('../src/services/syncState');

let failures = 0;
function assert(cond, msg) {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures += 1;
}

const catalog = (overrides = {}) => ([
  { ListID: 'A', Name: 'ITEM-A', QuantityOnHand: 10 },
  { ListID: 'B', Name: 'ITEM-B', QuantityOnHand: 5 },
  { ListID: 'C', Name: 'ITEM-C', QuantityOnHand: 0 },
  { ListID: 'D', Name: 'ITEM-D', QuantityOnHand: -3 }, // debe clamparse a 0
].map(it => ({ ...it, ...(overrides[it.ListID] || {}) })));

// 1) Primera corrida: siembra, no empuja.
let sel = selectItemsToSync(catalog());
assert(sel.reason === 'seed', 'primera corrida -> reason=seed');
assert(sel.toSync.length === 0, 'primera corrida -> no empuja nada');
assert(Object.keys(readState().byKey).length === 4, 'siembra 4 ítems');
assert(readState().byKey.D.shopifyQty === 0, 'cantidad negativa sembrada como 0');

// 2) Sin cambios -> nada que sincronizar.
sel = selectItemsToSync(catalog());
assert(sel.reason === 'diff' && sel.toSync.length === 0, 'sin cambios -> 0 a sincronizar');

// 3) Cambia B (5 -> 8) -> solo B.
sel = selectItemsToSync(catalog({ B: { QuantityOnHand: 8 } }));
assert(sel.toSync.length === 1 && sel.toSync[0].ListID === 'B', 'cambio en B -> solo B');

// 4) Confirmamos push OK de B -> ya no vuelve a salir.
recordResults([{ listId: 'B', sku: 'ITEM-B', target: 8, ok: true }]);
assert(readState().byKey.B.status === 'ok' && readState().byKey.B.shopifyQty === 8, 'B queda ok=8');
sel = selectItemsToSync(catalog({ B: { QuantityOnHand: 8 } }));
assert(sel.toSync.length === 0, 'B ya sincronizado -> no reaparece');

// 5) A falla con NO_MATCH -> queda unmatched y reaparece hasta el backoff.
sel = selectItemsToSync(catalog({ A: { QuantityOnHand: 12 } }));
assert(sel.toSync.some(i => i.ListID === 'A'), 'A cambiado -> entra al plan');
const sum = recordResults([{ listId: 'A', sku: 'ITEM-A', target: 12, ok: false, error: 'NO_MATCH' }]);
assert(readState().byKey.A.status === 'unmatched', 'A -> unmatched');
assert(sum.unmatchedItems.length === 1 && sum.unmatchedItems[0].listId === 'A', 'resumen lista A como unmatched');

// Inmediatamente después NO se reintenta (backoff sin vencer, misma cantidad).
sel = selectItemsToSync(catalog({ A: { QuantityOnHand: 12 } }));
assert(!sel.toSync.some(i => i.ListID === 'A'), 'A no se reintenta antes del backoff');

// Tras vencer el backoff, sí.
setTimeout(() => {
  let s = selectItemsToSync(catalog({ A: { QuantityOnHand: 12 } }));
  assert(s.toSync.some(i => i.ListID === 'A'), 'A se reintenta tras vencer el backoff');

  // 6) Tope MAX_SYNC_PER_RUN.
  resetState();
  const big = Array.from({ length: 20 }, (_, i) => ({ ListID: `X${i}`, Name: `X${i}`, QuantityOnHand: i }));
  selectItemsToSync(big);                       // seed
  const s2 = selectItemsToSync(big.map(it => ({ ...it, QuantityOnHand: it.QuantityOnHand + 1 })));
  assert(s2.capped === true && s2.toSync.length === 3, `tope respeta SYNC_MAX_PER_RUN (${s2.toSync.length})`);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failures === 0 ? '\nOK - todo verde' : `\n${failures} fallo(s)`);
  process.exit(failures === 0 ? 0 : 1);
}, 1200);
