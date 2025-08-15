// services/qbwcService.js
'use strict';

const fs = require('fs');
const crypto = require('crypto');

function logAuthAttempt(user, pass) {
  const userEnv = process.env.WC_USERNAME || '';
  const passEnv = process.env.WC_PASSWORD || '';
  console.log(
    `[QBWC] auth attempt user="${user}" matchUser=${user === userEnv} passLen=${(pass || '').length}`
  );
}

function makeTicket() {
  return (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
}

exports.qbwcServiceFactory = function qbwcServiceFactory() {
  return {
    QBWebConnectorSvcSoap: {
      QBWebConnectorSvcSoap: {
        /* -------- Versionado -------- */
        serverVersion(_args, cb) {
          // String vacío es aceptado por el WC (también puedes poner '1.0.0-dev')
          cb(null, { serverVersionResult: '' });
        },
        clientVersion({ strVersion }, cb) {
          // String vacío = compatible con cualquier WC
          cb(null, { clientVersionResult: '' });
        },

        /* -------- Autenticación -------- */
        authenticate({ strUserName, strPassword }, cb) {
          logAuthAttempt(strUserName, strPassword);

          const userEnv = process.env.WC_USERNAME || '';
          const passEnv = process.env.WC_PASSWORD || '';
          const ok = (strUserName === userEnv && strPassword === passEnv);

          if (!ok) {
            // EXACTO: 2 strings => ["", "nvu"]
            return cb(null, {
              authenticateResult: {
                $xml: '<string></string><string>nvu</string>'
              }
            });
          }

          const ticket = makeTicket();

          // EXACTO: 2 strings => [ticket, "none"]
          // Usamos $xml para evitar ambigüedades del serializer.
          const resultXml =
            `<string>${ticket}</string>` +
            `<string>none</string>`;

          return cb(null, {
            authenticateResult: { $xml: resultXml }
          });
        },

        /* -------- Qué pedir a QB -------- */
        sendRequestXML(_args, cb) {
          // QBXML mínimo de prueba: consulta 1 Item
          const qbxml =
            '<?xml version="1.0" encoding="utf-8"?>' +
            '<?qbxml version="13.0"?>' +
            '<QBXML>' +
            '  <QBXMLMsgsRq onError="stopOnError">' +
            '    <ItemQueryRq requestID="1">' +
            '      <MaxReturned>1</MaxReturned>' +
            '    </ItemQueryRq>' +
            '  </QBXMLMsgsRq>' +
            '</QBXML>';

          cb(null, { sendRequestXMLResult: qbxml });
        },

        /* -------- Respuesta de QB -------- */
        receiveResponseXML({ response }, cb) {
          try {
            fs.writeFileSync('/tmp/qbwc-last-response.xml', response || '', 'utf8');
          } catch (_) {}
          // 0 => 100% completado
          cb(null, { receiveResponseXMLResult: 0 });
        },

        /* -------- Errores / cierre -------- */
        connectionError(_args, cb) {
          cb(null, { connectionErrorResult: 'done' });
        },
        getLastError(_args, cb) {
          cb(null, { getLastErrorResult: '' });
        },
        closeConnection(_args, cb) {
          cb(null, { closeConnectionResult: 'OK' });
        }
      }
    }
  };
};
