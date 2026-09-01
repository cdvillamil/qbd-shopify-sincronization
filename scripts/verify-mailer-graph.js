'use strict';

// Verifica el camino de envío por Microsoft Graph (fetch simulado).
//   node scripts/verify-mailer-graph.js

process.env.MS_GRAPH_TENANT_ID = 'tenant-123';
process.env.MS_GRAPH_CLIENT_ID = 'client-123';
process.env.MS_GRAPH_CLIENT_SECRET = 'secret-123';
process.env.MS_GRAPH_SENDER = 'info@liondata.com.co';
process.env.ALERT_EMAIL_TO = 'info@liondata.com.co, otro@liondata.com.co';

const calls = [];
let sendFailsBefore = 0; // nº de respuestas 503 antes de un 202
global.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), opts });
  if (String(url).includes('/oauth2/v2.0/token')) {
    return { ok: true, status: 200, json: async () => ({ access_token: 'TOK', expires_in: 3600 }) };
  }
  if (String(url).includes('/sendMail')) {
    const n = calls.filter(c => c.url.includes('/sendMail')).length;
    if (n <= sendFailsBefore) {
      return { ok: false, status: 503, text: async () => '{"error":{"code":"CommandConcurrencyLimitReached"}}' };
    }
    return { ok: true, status: 202, text: async () => '' };
  }
  throw new Error('unexpected ' + url);
};

const { sendMail, isMailConfigured } = require('../src/services/mailer');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };

(async () => {
  assert(isMailConfigured() === true, 'isMailConfigured con Graph');

  const ok = await sendMail({ subject: 'prueba', text: 'cuerpo' });
  assert(ok === true, 'sendMail devuelve true (202)');

  const tokenCall = calls.find(c => c.url.includes('/token'));
  assert(tokenCall && new URLSearchParams(tokenCall.opts.body).get('grant_type') === 'client_credentials', 'token con client_credentials');
  assert(tokenCall.url.includes('tenant-123'), 'token al tenant correcto');

  const sendCall = calls.find(c => c.url.includes('/sendMail'));
  assert(sendCall.url.includes(encodeURIComponent('info@liondata.com.co')), 'sendMail desde el sender');
  assert(sendCall.opts.headers.Authorization === 'Bearer TOK', 'usa el bearer token');
  const bodyObj = JSON.parse(sendCall.opts.body);
  assert(bodyObj.message.toRecipients.length === 2, 'dos destinatarios');
  assert(bodyObj.message.subject === 'prueba' && bodyObj.message.body.content === 'cuerpo', 'subject y body');
  assert(bodyObj.saveToSentItems === false, 'no guarda en Enviados');

  // segundo envío: reusa el token cacheado
  calls.length = 0;
  await sendMail({ subject: 'otra', text: 'x' });
  assert(!calls.some(c => c.url.includes('/token')), 'segundo envío reusa token cacheado');

  // 503 transitorio 2 veces, luego 202 -> reintenta y termina true
  calls.length = 0;
  sendFailsBefore = 2;
  const ok2 = await sendMail({ subject: 'transitorio', text: 'y' });
  const sendCalls = calls.filter(c => c.url.includes('/sendMail')).length;
  assert(ok2 === true, '503 transitorio -> reintenta y devuelve true');
  assert(sendCalls === 3, `3 intentos de sendMail (${sendCalls})`);

  // 503 siempre -> se rinde y devuelve false (no rompe)
  calls.length = 0;
  sendFailsBefore = 99;
  const ok3 = await sendMail({ subject: 'siempre falla', text: 'z' });
  assert(ok3 === false, '503 permanente -> devuelve false sin lanzar');

  console.log(failures === 0 ? '\nOK - todo verde' : `\n${failures} fallo(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
