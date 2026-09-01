'use strict';

// Verificación manual del monitor del Web Connector. Uso:
//   node scripts/verify-wc-monitor.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wcmon-'));
process.env.LOG_DIR = TMP;
process.env.WC_DOWN_ALERT_ENABLED = 'true';
process.env.WC_DOWN_ALERT_MINUTES = '20';
process.env.WC_DOWN_ALERT_REPEAT_MINUTES = '60';

// Stub del mailer antes de requerir wcMonitor
const mailerPath = require.resolve('../src/services/mailer');
const sent = [];
let sendShouldFail = false;
require.cache[mailerPath] = {
  id: mailerPath, filename: mailerPath, loaded: true, exports: {
    sendMail: async (m) => { if (sendShouldFail) return false; sent.push(m); return true; },
    isMailConfigured: () => true,
  },
};

const { checkOnce } = require('../src/services/wcMonitor');
const SEEN = path.join(TMP, 'wc-last-seen.json');
const ALERT = path.join(TMP, 'wc-alert-state.json');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) failures++; };
const setSeen = (msAgo) => fs.writeFileSync(SEEN, JSON.stringify({ at: new Date(Date.now() - msAgo).toISOString() }));
const readAlert = () => JSON.parse(fs.readFileSync(ALERT, 'utf8'));
const MIN = 60000;

(async () => {
  // 1) WC visto hace 5 min -> nada
  setSeen(5 * MIN);
  await checkOnce();
  assert(sent.length === 0, 'WC activo -> sin email');

  // 2) WC visto hace 25 min -> 1 aviso de caida
  setSeen(25 * MIN);
  await checkOnce();
  assert(sent.length === 1 && /sin responder/.test(sent[0].subject), 'caida -> 1 aviso');

  // 3) chequeo inmediato -> no repite (aun no toca)
  await checkOnce();
  assert(sent.length === 1, 'no repite antes de 60 min');

  // 4) pasa >60 min desde el ultimo aviso -> recordatorio
  await checkOnce(Date.now() + 61 * MIN);
  assert(sent.length === 2 && /Aviso 2/.test(sent[1].text), 'recordatorio tras 60 min');

  // 5) WC vuelve -> aviso de recuperacion
  setSeen(2 * MIN);
  await checkOnce();
  assert(sent.length === 3 && /recuperado/.test(sent[2].subject), 'recuperacion -> 1 aviso');

  // 6) NUEVO: si el envio falla, se reintenta en el proximo ciclo (no 60 min)
  sent.length = 0;
  sendShouldFail = true;
  setSeen(25 * MIN);
  await checkOnce();                       // intento 1: falla
  assert(sent.length === 0, 'envio falla -> 0 correos');
  assert(readAlert().status === 'down' && !readAlert().lastAlertAt, 'estado down pero lastAlertAt vacio');
  await checkOnce();                       // intento 2 (mismo ciclo, ~inmediato): sigue fallando
  assert(sent.length === 0 && !readAlert().lastAlertAt, 'reintenta sin avanzar el reloj');
  sendShouldFail = false;
  await checkOnce();                       // intento 3: ahora si
  assert(sent.length === 1 && /sin responder/.test(sent[0].subject), 'al recuperarse el correo, avisa de inmediato');
  assert(readAlert().lastAlertAt && readAlert().alertCount === 1, 'ahora si avanza lastAlertAt/alertCount');
  await checkOnce();                       // ya avisado, no repite
  assert(sent.length === 1, 'tras exito, no repite hasta la hora');

  // 7) deshabilitado -> nada
  process.env.WC_DOWN_ALERT_ENABLED = 'false';
  sent.length = 0;
  setSeen(120 * MIN);
  await checkOnce();
  assert(sent.length === 0, 'deshabilitado -> sin emails');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failures === 0 ? '\nOK - todo verde' : `\n${failures} fallo(s)`);
  process.exit(failures === 0 ? 0 : 1);
})();
