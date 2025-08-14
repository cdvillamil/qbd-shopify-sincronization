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
          const user = (args && args.strUserName) || '';
          const pass = (args && args.strPassword) || '';
          const EXPECTED_USER = process.env.WC_USERNAME || 'dev_sync_user';
          const EXPECTED_PASS = process.env.WC_PASSWORD || 'your-dev-password';
          if (user !== EXPECTED_USER || pass !== EXPECTED_PASS) return cb(null, { authenticateResult: ['','nvu'] });
          const ticket = uuidv4();
          SESSIONS.set(ticket, { step: 0, lastError: '' });
          return cb(null, { authenticateResult: [ticket, ''] });
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
