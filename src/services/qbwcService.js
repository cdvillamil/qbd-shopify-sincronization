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
    // ⚠️ Debe calzar con el WSDL (service/port)
    QBWebConnectorSvc: {
      QBWebConnectorSvcSoap: {
        serverVersion(_args, cb) {
          cb(null, { serverVersionResult: '' }); // vacío aceptado
        },
        clientVersion({ strVersion }, cb) {
          cb(null, { clientVersionResult: '' }); // vacío aceptado
        },

        authenticate({ strUserName, strPassword }, cb) {
          logAuthAttempt(strUserName, strPassword);

          const userEnv = process.env.WC_USERNAME || '';
          const passEnv = process.env.WC_PASSWORD || '';
          const ok = (strUserName === userEnv && strPassword === passEnv);

          if (!ok) {
            // 2 strings => ["", "nvu"]
            return cb(null, { authenticateResult: { string: ['', 'nvu'] } });
          }

          const ticket = makeTicket();

          // 2 strings => [ticket, "none"]
          return cb(null, { authenticateResult: { string: [ticket, 'none'] } });

          // Si aún fallara, cambia por:
          // return cb(null, { authenticateResult: { $xml: `<string>${ticket}</string><string>none</string>` } });
        },

        sendRequestXML(_args, cb) {
          // QBXML mínimo de prueba
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

        receiveResponseXML({ response }, cb) {
          try { fs.writeFileSync('/tmp/qbwc-last-response.xml', response || '', 'utf8'); } catch {}
          cb(null, { receiveResponseXMLResult: 0 });
        },

        connectionError(_args, cb) { cb(null, { connectionErrorResult: 'done' }); },
        getLastError(_args, cb) { cb(null, { getLastErrorResult: '' }); },
        closeConnection(_args, cb) { cb(null, { closeConnectionResult: 'OK' }); }
      }
    }
  };
};
