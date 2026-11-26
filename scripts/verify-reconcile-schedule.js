'use strict';

// Verificación manual de la reconciliación a hora fija (SHOPIFY_RECONCILE_AT).
// Uso:  node scripts/verify-reconcile-schedule.js

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
const { isReconcileDue, lastScheduledSlot } = require('../src/services/shopify.sync');

let failures = 0;
function assert(cond, msg) {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures += 1;
}
const T = (iso) => Date.parse(iso);
const iso = (ms) => new Date(ms).toISOString();
const done = (startIso, extra = {}) => ({ status: 'completed', startedAt: startIso, finishedAt: startIso, dryRun: false, ...extra });

// 1) Cálculo del último horario programado
process.env.SHOPIFY_RECONCILE_TZ = 'America/Bogota'; // UTC-5, sin horario de verano
assert(iso(lastScheduledSlot(T('2026-11-26T05:40:00Z'), [{ h: 0, min: 30 }], 'America/Bogota')) === '2026-11-26T05:30:00.000Z',
  '00:30 Bogotá = 05:30 UTC (ya pasó hoy)');
assert(iso(lastScheduledSlot(T('2026-11-26T05:20:00Z'), [{ h: 0, min: 30 }], 'America/Bogota')) === '2026-11-25T05:30:00.000Z',
  'antes de la hora -> toma el día anterior');
assert(iso(lastScheduledSlot(T('2026-11-26T20:00:00Z'), [{ h: 0, min: 30 }, { h: 13, min: 0 }], 'America/Bogota')) === '2026-11-26T18:00:00.000Z',
  'con dos horarios toma el más reciente (13:00 Bogotá = 18:00 UTC)');
assert(iso(lastScheduledSlot(T('2026-07-15T05:00:00Z'), [{ h: 0, min: 30 }], 'America/New_York')) === '2026-07-15T04:30:00.000Z',
  'New York en verano (UTC-4): 00:30 = 04:30 UTC');
assert(iso(lastScheduledSlot(T('2026-12-15T06:00:00Z'), [{ h: 0, min: 30 }], 'America/New_York')) === '2026-12-15T05:30:00.000Z',
  'New York en invierno (UTC-5): 00:30 = 05:30 UTC');

// 2) Decisión de correr (00:30 Bogotá = 05:30 UTC)
process.env.SHOPIFY_RECONCILE_AT = '00:30';
const now = T('2026-11-26T05:35:00Z');
assert(isReconcileDue(done('2026-11-25T05:31:00Z'), now) === true, 'pasó la hora y la última fue ayer -> corre');
assert(isReconcileDue(done('2026-11-26T05:31:00Z'), now) === false, 'ya corrió hoy después de la hora -> no corre');
assert(isReconcileDue(done('2026-11-26T05:31:00Z'), T('2026-11-26T22:00:00Z')) === false, 'no se repite en el resto del día');
assert(isReconcileDue(done('2026-11-26T05:31:00Z'), T('2026-11-27T05:31:00Z')) === true, 'al día siguiente vuelve a correr');
assert(isReconcileDue(done('2026-11-26T05:33:00Z', { dryRun: true }), now) === true, 'un dryRun manual no cuenta como la corrida del día');
assert(isReconcileDue(null, now) === true, 'sin historial -> corre');
assert(isReconcileDue({ status: 'running' }, now) === false, 'si hay una corriendo -> no');
assert(isReconcileDue({ status: 'failed', finishedAt: '2026-11-26T05:30:30Z' }, now) === false, 'falló hace <20 min -> espera');
assert(isReconcileDue({ status: 'failed', finishedAt: '2026-11-26T05:00:00Z' }, now) === true, 'falló hace >20 min -> reintenta');
// WC caído a la hora programada: corre en el primer poll posterior, una sola vez.
assert(isReconcileDue(done('2026-11-25T05:31:00Z'), T('2026-11-26T09:00:00Z')) === true, 'WC caído a las 00:30 -> corre al volver');

// 3) Sin SHOPIFY_RECONCILE_AT se mantiene el intervalo
delete process.env.SHOPIFY_RECONCILE_AT;
process.env.SHOPIFY_RECONCILE_INTERVAL_MS = String(60 * 60 * 1000);
assert(isReconcileDue(done('2026-11-26T05:00:00Z'), T('2026-11-26T05:30:00Z')) === false, 'modo intervalo: <1 h -> no corre');
assert(isReconcileDue(done('2026-11-26T05:00:00Z'), T('2026-11-26T06:01:00Z')) === true, 'modo intervalo: >1 h -> corre');

console.log(failures ? `\n${failures} FALLO(S)` : '\nTodo OK');
process.exit(failures ? 1 : 0);
