'use strict';

// Verifica que pruneLogFiles respeta la opción `dir` y que DEBUG_DIR se separa
// de LOG_DIR.  node scripts/verify-debug-dir.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG = fs.mkdtempSync(path.join(os.tmpdir(), 'logdir-'));
const DBG = fs.mkdtempSync(path.join(os.tmpdir(), 'dbgdir-'));
process.env.LOG_DIR = LOG;
process.env.DEBUG_DIR = DBG;

const { DEBUG_DIR, LOG_DIR, pruneLogFiles } = require('../src/services/jobQueue');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

assert(LOG_DIR === LOG, 'LOG_DIR = temp log');
assert(DEBUG_DIR === DBG, 'DEBUG_DIR = temp debug (separado)');

// 12 archivos "last-response-*.xml" en DEBUG_DIR, timestamps crecientes
for (let i = 1; i <= 12; i++) {
  fs.writeFileSync(path.join(DBG, `last-response-${1000000000000 + i}.xml`), 'x');
}
// un archivo que NO debe tocarse
fs.writeFileSync(path.join(DBG, 'jobs.json'), '[]');
// un last-response en LOG_DIR que NO debe tocarse (dir equivocado)
fs.writeFileSync(path.join(LOG, 'last-response-1000000000099.xml'), 'x');

const removed = pruneLogFiles(/^last-response-\d+\.xml$/, { keep: 5, dir: DBG });
assert(removed === 7, `podó 7 (dejó 5) — quitó ${removed}`);

const left = fs.readdirSync(DBG).filter(n => /^last-response-\d+\.xml$/.test(n));
assert(left.length === 5, `quedan 5 last-response en DEBUG_DIR (${left.length})`);
assert(fs.existsSync(path.join(DBG, 'jobs.json')), 'jobs.json intacto');
assert(fs.existsSync(path.join(LOG, 'last-response-1000000000099.xml')), 'no tocó LOG_DIR');

try { fs.rmSync(LOG, { recursive: true, force: true }); fs.rmSync(DBG, { recursive: true, force: true }); } catch {}
console.log(failures === 0 ? '\nOK - todo verde' : `\n${failures} fallo(s)`);
process.exit(failures === 0 ? 0 : 1);
