'use strict';
const { v4: uuidv4 } = require('uuid');
const { buildMinimalInventoryQuery } = require('../qbxml/builders');
const SESSIONS = new Map();

function qbwcServiceFactory() {
  return {
    QBWebConnectorSvc: {
      QBWebConnectorSvcSoap: {
        serverVersion(args, cb) { cb(null, { serverVersionResult: '1.0.0-dev' }); },
        clientVersion(args, cb) { cb(null, { clientVersionResult: '' }); },
        authenticate(args, cb) {
          const user = args?.strUserName || '';
          const pass = args?.strPassword || '';

          const EXPECTED_USER = process.env.WC_USERNAME;
          const EXPECTED_PASS = process.env.WC_PASSWORD;
          const PERMISSIVE    = process.env.AUTH_PERMISSIVE === '1';

          console.log(`[QBWC] auth attempt user="${user}" matchUser=${user===EXPECTED_USER} passLen=${(pass||'').length}`);

          const ok = PERMISSIVE || (user === EXPECTED_USER && pass === EXPECTED_PASS);
          const { v4: uuidv4 } = require('uuid');

          if (!ok) {
            // con ArrayOfString en el WSDL, el array se devuelve como { string: [...] }
            return cb(null, { authenticateResult: { string: ['', 'nvu'] } });
          }

          const ticket = uuidv4();
          // 2º string NO vacío para evitar el bug del WC con cadenas vacías
          return cb(null, { authenticateResult: { string: [ticket, 'none'] } });
        },
        sendRequestXML(args, cb) {
          const ticket = args && args.ticket;
          const sess = SESSIONS.get(ticket);
          if (!sess) return cb(null, { sendRequestXMLResult: '' });
          if (sess.step === 0) {
            const qbxml = buildMinimalInventoryQuery(1);
            sess.step = 1;
            return cb(null, { sendRequestXMLResult: qbxml });
          }
          return cb(null, { sendRequestXMLResult: '' });
        },
        receiveResponseXML(args, cb) {
          const ticket = args && args.ticket;
          const sess = SESSIONS.get(ticket);
          if (sess) { sess.step = 999; sess.lastError = ''; }
          cb(null, { receiveResponseXMLResult: 100 });
        },
        getLastError(args, cb) {
          const ticket = args && args.ticket;
          const sess = SESSIONS.get(ticket);
          const msg = (sess && sess.lastError) || '';
          cb(null, { getLastErrorResult: msg });
        },
        connectionError(args, cb) {
          const ticket = args && args.ticket;
          const sess = SESSIONS.get(ticket);
          if (sess) sess.lastError = `ConnectionError hresult=${args.hresult || ''} message=${args.message || ''}`;
          cb(null, { connectionErrorResult: 'done' });
        },
        closeConnection(args, cb) {
          const ticket = args && args.ticket;
          SESSIONS.delete(ticket);
          cb(null, { closeConnectionResult: 'OK' });
        }
      }
    }
  };
}
module.exports = { qbwcServiceFactory };
