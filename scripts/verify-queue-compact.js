'use strict';

// Verificación manual (sin servidor / sin QBD / sin Shopify) de la cola cuando
// el Web Connector estuvo detenido varios días. Uso:  node scripts/verify-queue-compact.js
//
// Cubre: authenticate no apila inventoryQuery si ya hay uno pendiente, y la
// compactación deja uno solo al final sin perder ni reordenar los pedidos.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-'));
process.env.LOG_DIR = TMP;

const q = require('../src/services/jobQueue');

let failures = 0;
function assert(cond, msg) {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures += 1;
}

(async () => {
  // 1) Dedupe en authenticate.
  let r = await q.enqueueUnlessPending({ type: 'inventoryQuery', ts: 't1' });
  assert(r.queued === true, 'primer inventoryQuery se encola');
  r = await q.enqueueUnlessPending({ type: 'inventoryQuery', ts: 't2' });
  assert(r.queued === false && q.readJobs().length === 1, 'segundo inventoryQuery no se apila');
  await q.enqueueJob({ type: 'invoiceAdd', id: 'A' });
  r = await q.enqueueUnlessPending({ type: 'inventoryQuery', ts: 't3' });
  assert(r.queued === false, 'tampoco se apila si el pendiente no es el primero de la cola');

  // 2) Compactación de una cola acumulada (caso real: días sin procesar).
  q.writeJobs([]);
  const jobs = [];
  for (let i = 0; i < 300; i++) {
    jobs.push({ type: 'inventoryQuery', ts: `inv-${i}` });
    if (i % 50 === 0) jobs.push({ type: 'invoiceAdd', id: `ORD-${i}` });
  }
  jobs.push({ type: 'creditMemoAdd', id: 'CM-1' });
  q.writeJobs(jobs);

  const dry = await q.compactInventoryQueries({ dryRun: true });
  assert(dry.removed === 299 && q.readJobs().length === jobs.length, 'dryRun informa sin modificar la cola');

  const res = await q.compactInventoryQueries();
  const after = q.readJobs();
  assert(res.removed === 299, `elimina 299 inventoryQuery sobrantes (${res.removed})`);
  assert(after.filter(j => j.type === 'inventoryQuery').length === 1, 'queda un solo inventoryQuery');
  assert(after[after.length - 1].type === 'inventoryQuery' && after[after.length - 1].ts === 'inv-299',
    'el inventoryQuery que queda es el más reciente y va al final');
  const orders = after.filter(j => j.type !== 'inventoryQuery').map(j => j.id);
  assert(JSON.stringify(orders) === JSON.stringify(['ORD-0', 'ORD-50', 'ORD-100', 'ORD-150', 'ORD-200', 'ORD-250', 'CM-1']),
    `pedidos y notas crédito intactos y en orden (${orders})`);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FALLO(S)` : '\nTodo OK');
  process.exit(failures ? 1 : 0);
})();
