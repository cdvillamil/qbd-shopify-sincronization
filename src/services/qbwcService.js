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
  // ticket único por sesión
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

exports.qbwcServiceFactory = function qbwcServiceFactory() {
  return {
    QBWebConnectorSvcSoap: {
      QBWebConnectorSvcSoap: {
        // ----- Versionado -----
        serverVersion(_args, cb) {
          cb(null, { serverVersionResult: '1.0.0-dev' });
        },
        clientVersion({ strVersion }, cb) {
          // devolver string vacío ==> compatible con todas
          cb(null, { clientVersionResult: '' });
        },

        // ----- Autenticación -----
        authenticate({ strUserName, strPassword }, cb) {
          logAuthAttempt(strUserName, strPassword);

          const userEnv = process.env.WC_USERNAME || '';
          const passEnv = process.env.WC_PASSWORD || '';

          const ok = strUserName === userEnv && strPassword === passEnv;

          if (!ok) {
            // Respuesta "usuario no válido": 2 strings
            // 1) ticket vacío  2) 'nvu'
            return cb(null, {
              authenticateResult: { string: ['', 'nvu'] }
            });
          }

          const ticket = makeTicket();

          // Caso OK: 2 strings -> [ticket, 'none']
          // ('none' es válido para continuar el flujo)
          cb(null, {
            authenticateResult: { string: [ticket, 'none'] }
          });
        },

        // ----- Petición al QB (qué quieres que ejecute) -----
        sendRequestXML(args, cb) {
          // Para el stub, mandamos una consulta mínima (no importa lo que sea)
          // QBWC solo quiere un QBXML bien formado.
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

        // ----- Respuesta de QB -----
        receiveResponseXML({ ticket, response, hresult, message }, cb) {
          try {
            fs.writeFileSync('/tmp/qbwc-last-response.xml', response || '', 'utf8');
          } catch (_) {}

          // 0 ==> 100% completado. Puedes ajustar a 50, 75, etc.
          cb(null, { receiveResponseXMLResult: 0 });
        },

        // ----- Errores / cierre -----
        connectionError({ ticket, hresult, message }, cb) {
          cb(null, { connectionErrorResult: 'done' });
        },
        getLastError({ ticket }, cb) {
          cb(null, { getLastErrorResult: '' });
        },
        closeConnection({ ticket }, cb) {
          cb(null, { closeConnectionResult: 'OK' });
        }
      }
    }
  };
};
