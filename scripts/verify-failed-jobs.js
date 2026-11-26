'use strict';

// Verificación manual (sin servidor / sin QBD / sin Shopify) de la detección de
// rechazos de QuickBooks y del registro de jobs fallidos.
// Uso:  node scripts/verify-failed-jobs.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-'));
process.env.LOG_DIR = TMP;

const { analyzeQbResponse } = require('../src/services/qbResponse');
const failed = require('../src/services/failedJobs');
const q = require('../src/services/jobQueue');

let failures = 0;
function assert(cond, msg) {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures += 1;
}

const ok = '<QBXML><QBXMLMsgsRs><InvoiceAddRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK"><InvoiceRet/></InvoiceAddRs></QBXMLMsgsRs></QBXML>';
const bad = '<QBXML><QBXMLMsgsRs><InvoiceAddRs requestID="1" statusCode="3140" statusSeverity="Error" statusMessage="There is an invalid reference to QuickBooks Item &quot;SHOPIFY DISCOUNT&quot;"/></QBXMLMsgsRs></QBXML>';
const warn = '<QBXML><QBXMLMsgsRs><SalesReceiptAddRs statusCode="530" statusSeverity="Warn" statusMessage="aviso"/></QBXMLMsgsRs></QBXML>';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

(async () => {
  // 1) Analizador
  assert(analyzeQbResponse(ok).errors.length === 0, 'InvoiceAddRs statusCode=0 no es error');
  let r = analyzeQbResponse(bad);
  assert(r.errors.length === 1 && r.errors[0].code === '3140' && r.errors[0].node === 'InvoiceAddRs', 'InvoiceAddRs 3140 se detecta');
  r = analyzeQbResponse(esc(bad));
  assert(r.errors.length === 1 && r.errors[0].code === '3140', 'también si la respuesta llega escapada (&lt;…&gt;)');
  assert(analyzeQbResponse(warn).errors.length === 0, 'statusSeverity=Warn no se trata como rechazo');
  assert(analyzeQbResponse('').errors.length === 0, 'respuesta vacía no rompe');

  // 2) Registro, reintento y descarte
  const inv = { type: 'invoiceAdd', source: 'shopify-order', payload: { memo: '1646', lines: [] } };
  const e1 = failed.recordFailedJob(inv, { status: 'failed', error: 'InvoiceAddRs statusCode=3140' });
  const e2 = failed.recordFailedJob({ type: 'salesReceiptAdd', payload: { memo: '1647' } }, { status: 'unconfirmed', error: 'corte' });
  assert(failed.readFailed().length === 2, 'dos jobs registrados');

  q.writeJobs([{ type: 'inventoryQuery' }]);
  const rt = await failed.retryFailed([e1.id]);
  const jobs = q.readJobs();
  assert(rt.retried.length === 1 && rt.retried[0].memo === '1646', 'retry devuelve el pedido 1646');
  assert(jobs.length === 2 && jobs[1].type === 'invoiceAdd' && jobs[1].payload.memo === '1646' && jobs[1].retryOf === e1.id,
    'el job reintentado vuelve a la cola con su payload intacto');
  assert(failed.readFailed().length === 1 && failed.readFailed()[0].id === e2.id, 'sale del registro de fallidos');

  const dis = failed.takeFailed([e2.id]);
  assert(dis.length === 1 && failed.readFailed().length === 0, 'dismiss lo quita sin reencolar');
  assert(q.readJobs().length === 2, 'dismiss no toca la cola');

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FALLO(S)` : '\nTodo OK');
  process.exit(failures ? 1 : 0);
})();
