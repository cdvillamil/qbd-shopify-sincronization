'use strict';

// Jobs que QuickBooks rechazó (status=failed) o cuyo resultado nunca se confirmó
// porque el ciclo del Web Connector se cortó (status=unconfirmed). Antes se
// perdían sin rastro: el job sale de la cola al enviarse a QB.
//
// Archivo: <LOG_DIR>/failed-jobs.json  ->  [{ id, status, failedAt, error, job }]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LOG_DIR, ensureDir, withJobsLock } = require('./jobQueue');

const FAILED_PATH = path.join(LOG_DIR, 'failed-jobs.json');

function readFailed() {
  try {
    if (!fs.existsSync(FAILED_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(FAILED_PATH, 'utf8') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[failedJobs] read error', err?.message || err);
    return [];
  }
}

function writeFailed(list) {
  ensureDir();
  const tmp = `${FAILED_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
  fs.renameSync(tmp, FAILED_PATH);
}

function recordFailedJob(job, { status = 'failed', error = '' } = {}) {
  if (!job) return null;
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    status,
    failedAt: new Date().toISOString(),
    error: String(error || ''),
    job,
  };
  const list = readFailed();
  list.push(entry);
  writeFailed(list);
  console.error('[failedJobs] job registrado', {
    id: entry.id, status, type: job.type, memo: job.payload?.memo ?? null, error: entry.error,
  });
  notify(entry);
  return entry;
}

// Aviso por correo (mismo canal que la alerta del Web Connector). No bloquea.
function notify(entry) {
  try {
    const { sendMail, isMailConfigured } = require('./mailer');
    if (!isMailConfigured()) return;
    const memo = entry.job.payload?.memo;
    const what = `${entry.job.type}${memo ? ` (pedido ${memo})` : ''}`;
    const subject = entry.status === 'failed'
      ? `[QBD-Shopify] QuickBooks rechazó ${what}`
      : `[QBD-Shopify] Sin confirmar en QuickBooks: ${what}`;
    const text =
`${entry.status === 'failed'
  ? 'QuickBooks rechazo este documento; NO se creo en QBD.'
  : 'El ciclo del Web Connector se corto antes de recibir la respuesta de QuickBooks. Verifica en QBD si el documento existe antes de reintentarlo (podria duplicarse).'}

Tipo: ${entry.job.type}
Pedido/memo: ${memo || '-'}
Error: ${entry.error || '-'}
Registrado: ${entry.failedAt}
Id: ${entry.id}

Ver: GET /debug/failed-jobs
Reintentar tras corregir la causa: POST /debug/failed-jobs/retry?id=${entry.id}
Descartar (si se creo a mano): POST /debug/failed-jobs/dismiss?id=${entry.id}`;
    Promise.resolve(sendMail({ subject, text })).catch((err) => {
      console.warn('[failedJobs] aviso por correo falló', err?.message || err);
    });
  } catch (err) {
    console.warn('[failedJobs] aviso por correo falló', err?.message || err);
  }
}

// Quita entradas por id (o todas si ids es null) y las devuelve.
function takeFailed(ids) {
  const list = readFailed();
  const want = ids ? new Set(ids) : null;
  const taken = [];
  const kept = [];
  for (const e of list) (want && !want.has(e.id) ? kept : taken).push(e);
  writeFailed(kept);
  return taken;
}

// Reencola al FINAL de la cola los jobs indicados y los saca del registro.
async function retryFailed(ids) {
  const taken = takeFailed(ids);
  if (!taken.length) return { retried: [] };
  await withJobsLock(async (jobs) => {
    for (const e of taken) jobs.push({ ...e.job, retryOf: e.id, retriedAt: new Date().toISOString() });
  });
  return { retried: taken.map((e) => ({ id: e.id, type: e.job.type, memo: e.job.payload?.memo ?? null })) };
}

module.exports = { FAILED_PATH, readFailed, recordFailedJob, takeFailed, retryFailed };
