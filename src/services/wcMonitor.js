'use strict';

// Vigila la actividad del QuickBooks Web Connector y avisa por email cuando
// lleva demasiado tiempo sin hacer una consulta (= sincronización detenida).
//
// - Aviso al detectar caída (sin poll por >= WC_DOWN_ALERT_MINUTES, default 20).
// - Recordatorio cada WC_DOWN_ALERT_REPEAT_MINUTES (default 60) mientras siga caído.
// - Un aviso de "recuperado" cuando el WC vuelve a responder.
//
// Se habilita solo si hay SMTP configurado (ver mailer.js), salvo que se fuerce
// con WC_DOWN_ALERT_ENABLED=true / false.

const fs = require('fs');
const path = require('path');
const { LOG_DIR, ensureDir } = require('./jobQueue');
const { sendMail, isMailConfigured } = require('./mailer');

const SEEN_PATH = path.join(LOG_DIR, 'wc-last-seen.json');
const ALERT_PATH = path.join(LOG_DIR, 'wc-alert-state.json');

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

const DOWN_MINUTES = num(process.env.WC_DOWN_ALERT_MINUTES, 20);
const REPEAT_MINUTES = num(process.env.WC_DOWN_ALERT_REPEAT_MINUTES, 60);
const CHECK_MS = num(process.env.WC_MONITOR_CHECK_MS, 5 * 60 * 1000);

function readJson(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function writeJson(p, v) {
  try {
    ensureDir();
    fs.writeFileSync(p, JSON.stringify(v, null, 2), 'utf8');
  } catch (e) {
    console.warn('[wc-monitor] write error', p, e?.message || e);
  }
}

function recordWcSeen(method) {
  writeJson(SEEN_PATH, { at: new Date().toISOString(), method: method || null });
}

function lastSeenAt() {
  const t = Date.parse(readJson(SEEN_PATH)?.at || '');
  return Number.isFinite(t) ? t : null;
}

function isEnabled() {
  const raw = String(process.env.WC_DOWN_ALERT_ENABLED || '').trim();
  if (raw === '') return isMailConfigured();
  return /^(1|true|yes)$/i.test(raw);
}

function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

async function checkOnce(now = Date.now()) {
  if (!isEnabled()) return;

  const seen = lastSeenAt();
  if (!seen) return; // aún sin registro (arranque muy reciente)

  const state = readJson(ALERT_PATH) || { status: 'up', downSince: null, lastAlertAt: null, alertCount: 0 };
  const downForMs = now - seen;
  const threshold = DOWN_MINUTES * 60000;

  if (downForMs >= threshold) {
    const firstAlert = state.status !== 'down';
    const lastAlert = Date.parse(state.lastAlertAt || '') || 0;
    const dueRepeat = lastAlert && now - lastAlert >= REPEAT_MINUTES * 60000;
    if (!firstAlert && !dueRepeat) return;

    const sinceIso = new Date(seen).toISOString();
    const n = (firstAlert ? 0 : (state.alertCount || 0)) + 1;
    await sendMail({
      subject: `[QBD-Shopify] Web Connector sin responder hace ${fmtDuration(downForMs)}`,
      text:
`El QuickBooks Web Connector no realiza una consulta desde hace ${fmtDuration(downForMs)}.
Ultimo contacto: ${sinceIso}

La sincronizacion QBD -> Shopify esta detenida hasta que el Web Connector vuelva a ejecutarse.
Accion: abrir el Web Connector en la VM de QuickBooks y ejecutar / reanudar la tarea.

(Aviso ${n}. Se repite cada ${REPEAT_MINUTES} min mientras siga caido.)`,
    });
    writeJson(ALERT_PATH, {
      status: 'down',
      downSince: firstAlert ? sinceIso : (state.downSince || sinceIso),
      lastAlertAt: new Date(now).toISOString(),
      alertCount: n,
    });
    return;
  }

  // WC visto recientemente
  if (state.status === 'down') {
    await sendMail({
      subject: '[QBD-Shopify] Web Connector recuperado',
      text:
`El Web Connector volvio a responder (${new Date(seen).toISOString()}).
Estuvo sin responder desde ${state.downSince || 'desconocido'} (${state.alertCount || 0} aviso(s) enviados).
La sincronizacion QBD -> Shopify se reanudo.`,
    });
    writeJson(ALERT_PATH, { status: 'up', downSince: null, lastAlertAt: null, alertCount: 0 });
  }
}

function startWcMonitor() {
  if (!isEnabled()) {
    console.log('[wc-monitor] deshabilitado (configura SMTP_* + ALERT_EMAIL_TO, o WC_DOWN_ALERT_ENABLED=true).');
    return;
  }
  // Primer arranque sin historial: cuenta desde ahora para dar margen a que el WC reconecte.
  if (!lastSeenAt()) recordWcSeen('startup-seed');
  console.log(`[wc-monitor] activo; umbral=${DOWN_MINUTES}min; repeticion=${REPEAT_MINUTES}min; check=${Math.round(CHECK_MS / 1000)}s`);
  checkOnce().catch((e) => console.error('[wc-monitor] check error:', e?.message || e));
  setInterval(() => {
    checkOnce().catch((e) => console.error('[wc-monitor] check error:', e?.message || e));
  }, CHECK_MS);
}

function wcStatus() {
  const seen = lastSeenAt();
  return {
    enabled: isEnabled(),
    thresholdMinutes: DOWN_MINUTES,
    repeatMinutes: REPEAT_MINUTES,
    lastSeen: readJson(SEEN_PATH),
    minutesSinceLastSeen: seen ? Math.round((Date.now() - seen) / 60000) : null,
    alert: readJson(ALERT_PATH),
  };
}

module.exports = { recordWcSeen, startWcMonitor, checkOnce, wcStatus };
