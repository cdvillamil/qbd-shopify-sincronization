'use strict';

// Envío de email para las alertas. Dos caminos, en este orden de preferencia:
//
//  1) Microsoft Graph (recomendado para tenants con Security Defaults / MFA).
//     Requiere un registro de app en Entra con permiso de APLICACIÓN "Mail.Send"
//     (con consentimiento de administrador).
//       MS_GRAPH_TENANT_ID
//       MS_GRAPH_CLIENT_ID
//       MS_GRAPH_CLIENT_SECRET
//       MS_GRAPH_SENDER        buzón desde el que se envía (p.ej. info@liondata.com.co)
//       ALERT_EMAIL_TO         destinatario/s (coma-separados)
//
//  2) SMTP (nodemailer). Solo si el tenant permite SMTP AUTH básico.
//       SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASS
//       ALERT_EMAIL_TO / ALERT_EMAIL_FROM
//
// Si nada está configurado (o falta nodemailer para el camino SMTP), hace no-op
// sin romper el servidor.

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (_) { nodemailer = null; }

const _fetch = (typeof fetch === 'function')
  ? fetch
  : (...args) => import('node-fetch').then(m => m.default(...args));

/* ================= Config ================= */
function graphConfig() {
  const tenant = (process.env.MS_GRAPH_TENANT_ID || '').trim();
  const clientId = (process.env.MS_GRAPH_CLIENT_ID || '').trim();
  const clientSecret = process.env.MS_GRAPH_CLIENT_SECRET || '';
  const sender = (process.env.MS_GRAPH_SENDER || process.env.ALERT_EMAIL_FROM || '').trim();
  const to = (process.env.ALERT_EMAIL_TO || '').trim();
  if (!tenant || !clientId || !clientSecret || !sender || !to) return null;
  return { tenant, clientId, clientSecret, sender, to };
}

function smtpConfig() {
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const pass = process.env.SMTP_PASS || '';
  const to = (process.env.ALERT_EMAIL_TO || '').trim();
  if (!host || !user || !pass || !to) return null;
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = /^(1|true|yes)$/i.test(String(process.env.SMTP_SECURE || '').trim()) || port === 465;
  const from = (process.env.ALERT_EMAIL_FROM || '').trim() || user;
  return { host, port, secure, user, pass, to, from };
}

function isMailConfigured() {
  return Boolean(graphConfig() || (nodemailer && smtpConfig()));
}

function recipients(to) {
  return String(to).split(',').map(s => s.trim()).filter(Boolean)
    .map(address => ({ emailAddress: { address } }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms || 0)));

// fetch con timeout (AbortController) para que una llamada colgada falle rápido.
async function fetchWithTimeout(url, opts, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await _fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/* ================= Microsoft Graph ================= */
let _token = { value: null, exp: 0 };

async function graphToken(cfg) {
  const now = Date.now();
  if (_token.value && now < _token.exp - 60000) return _token.value;

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const r = await fetchWithTimeout(
    `https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
    15000
  );
  const json = await r.json().catch(() => ({}));
  if (!r.ok || !json.access_token) {
    throw new Error(`token ${r.status}: ${JSON.stringify(json.error || json)}`);
  }
  _token = { value: json.access_token, exp: now + (Number(json.expires_in || 3600) * 1000) };
  return _token.value;
}

// Graph / Exchange Online devuelve 5xx transitorios con frecuencia
// (Keyset does not exist, Concurrency Limit Reached, 504...). Reintentamos
// unas pocas veces antes de rendirnos en este ciclo.
async function sendViaGraph(cfg, { subject, text }) {
  const payload = {
    message: {
      subject,
      body: { contentType: 'Text', content: text },
      toRecipients: recipients(cfg.to),
    },
    saveToSentItems: false,
  };

  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const token = await graphToken(cfg);
      const r = await fetchWithTimeout(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.sender)}/sendMail`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        15000
      );
      if (r.status === 202) return true;

      const errText = await r.text().catch(() => '');
      lastErr = new Error(`sendMail ${r.status}: ${errText.slice(0, 300)}`);
      // 4xx (salvo 429) = error permanente, no reintentar.
      if (r.status < 500 && r.status !== 429) throw lastErr;
    } catch (err) {
      lastErr = err;
      if (err && /sendMail 4\d\d/.test(String(err.message)) && !/sendMail 429/.test(String(err.message))) {
        throw err;
      }
    }
    if (attempt < 4) await sleep(1500 * attempt);
  }
  throw lastErr;
}

/* ================= SMTP ================= */
let _transport = null;
function getTransport(cfg) {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: !cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return _transport;
}

async function sendViaSmtp(cfg, { subject, text }) {
  await getTransport(cfg).sendMail({ from: cfg.from, to: cfg.to, subject, text });
  return true;
}

/* ================= API pública ================= */
async function sendMail({ subject, text }) {
  const g = graphConfig();
  if (g) {
    try {
      await sendViaGraph(g, { subject, text });
      console.log('[mailer] enviado (graph):', subject);
      return true;
    } catch (err) {
      console.error('[mailer] fallo Graph:', err?.message || err);
      return false;
    }
  }

  const s = smtpConfig();
  if (s && nodemailer) {
    try {
      await sendViaSmtp(s, { subject, text });
      console.log('[mailer] enviado (smtp):', subject);
      return true;
    } catch (err) {
      console.error('[mailer] fallo SMTP:', err?.message || err);
      return false;
    }
  }

  console.warn('[mailer] sin configurar (Graph ni SMTP); email omitido:', subject);
  return false;
}

module.exports = { sendMail, isMailConfigured };
