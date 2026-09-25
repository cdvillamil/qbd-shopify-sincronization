'use strict';

// Verificación manual (sin servidor / sin QBD / sin Shopify) de la detección de
// locks huérfanos del sync QBD -> Shopify. Uso:  node scripts/verify-sync-lock.js
//
// Cubre: lock vigente bloquea, lock expirado se limpia, lock de un PID muerto en
// el mismo host se limpia, y la liberación manual.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'synclock-'));
process.env.LOG_DIR = TMP;
process.env.SHOPIFY_SYNC_LOCK_STALE_MS = '60000'; // 1 min

const { isSyncLocked, getLockStatus, forceReleaseLock } = require('../src/services/shopify.sync');
const LOCK_PATH = path.join(TMP, 'shopify-sync.lock');

let failures = 0;
function assert(cond, msg) {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures += 1;
}
function writeLock(meta) {
  fs.writeFileSync(LOCK_PATH, JSON.stringify(meta), 'utf8');
}

// 1) Sin lock.
assert(isSyncLocked() === false, 'sin lock -> no bloqueado');

// 2) Lock vigente de este mismo proceso.
writeLock({ pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() });
assert(isSyncLocked() === true, 'lock reciente de un proceso vivo -> bloqueado');
assert(fs.existsSync(LOCK_PATH), 'lock vigente no se borra');

// 3) Lock de otro host, reciente: no se puede verificar el PID -> vigente.
writeLock({ pid: 1879, hostname: 'otro-host', acquiredAt: new Date().toISOString() });
assert(isSyncLocked() === true, 'lock reciente de otro host -> bloqueado');

// 4) Lock expirado (caso real: 11 días en otro contenedor).
writeLock({ pid: 1879, hostname: '875ed95d1919', acquiredAt: '2026-09-14T16:34:05.745Z' });
assert(getLockStatus().stale === 'expired', 'getLockStatus reporta expired');
assert(isSyncLocked() === false, 'lock expirado -> se limpia y no bloquea');
assert(!fs.existsSync(LOCK_PATH), 'lock expirado borrado del disco');

// 5) Lock reciente de un PID muerto en este host.
writeLock({ pid: 2147483646, hostname: os.hostname(), acquiredAt: new Date().toISOString() });
assert(isSyncLocked() === false, 'PID muerto en el mismo host -> se limpia');

// 6) Liberación manual.
writeLock({ pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() });
const r = forceReleaseLock();
assert(r.released === true && !fs.existsSync(LOCK_PATH), 'forceReleaseLock borra el lock');
assert(forceReleaseLock().released === false, 'forceReleaseLock sin lock -> released=false');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} FALLO(S)` : '\nTodo OK');
process.exit(failures ? 1 : 0);
