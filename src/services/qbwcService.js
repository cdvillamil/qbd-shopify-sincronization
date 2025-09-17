// src/services/qbwcService.js
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { prepareNextRequest, handleResponse } = require('./qbwc.queue');
const { enqueue } = require('./jobQueue');

/**
 * OBJETIVO
 * - Mantener authenticate EXACTO (usuario/contraseña desde variables de entorno).
 * - Integrar QuickBooks Web Connector con la cola de trabajos (InventoryQuery/InventoryAdjust, etc.).
 * - Guardar archivos de depuración en /tmp para validar fácilmente desde tus endpoints actuales (/debug/*).
 */

/* =========================
   Configuración y helpers
   ========================= */
const LOG_DIR = process.env.LOG_DIR || '/tmp';
const TNS = 'http://developer.intuit.com/';

const APP_USER = process.env.WC_USERNAME || '';
const APP_PASS = process.env.WC_PASSWORD || '';

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch { /* noop */ } }
function save(name, txt) { ensureDir(LOG_DIR); fs.writeFileSync(path.join(LOG_DIR, name), txt ?? '', 'utf8'); }
function sha256(s) { return crypto.createHash('sha256').update(s || '').digest('hex'); }

/* =========================
   Servicio SOAP
   ========================= */
function qbwcServiceFactory() {
  // Implementación real de los métodos
  const impl = {
    serverVersion(args, cb) {
      cb(null, { serverVersionResult: '1.0.0-dev' });
    },

    clientVersion(args, cb) {
      cb(null, { clientVersionResult: '' }); // Acepta cualquier versión del WC
    },

    authenticate(args, cb) {
      const user = (args?.strUserName || '').trim();
      const pass = args?.strPassword || '';

      // Auditar lo recibido para /debug/last-auth-cred
      save('last-auth-request.xml', JSON.stringify({ Body: { authenticate: { strUserName: user, strPassword: pass } } }, null, 2));
      save('last-auth-cred.json', JSON.stringify({
        ts: new Date().toISOString(),
        receivedUser: user,
        receivedPassLen: pass.length,
        receivedPassSha256: sha256(pass),
        envUser: APP_USER,
        envPassLen: APP_PASS.length,
        envPassSha256: sha256(APP_PASS),
        matchUser: user === APP_USER,
        matchPassHash: pass === APP_PASS
      }, null, 2));

      if (user !== APP_USER || pass !== APP_PASS) {
        // Not valid user → nvu (not valid user)
        save('last-auth-response.xml',
          `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${TNS}"><soap:Body><tns:authenticateResponse><authenticateResult><string></string><string>nvu</string></authenticateResult></tns:authenticateResponse></soap:Body></soap:Envelope>`);
        return cb(null, { authenticateResult: ['', 'nvu'] });
      }

      const ticket = crypto.randomUUID();
      if (user === APP_USER && pass === APP_PASS) {
        try {
          if (process.env.AUTO_SEED_ON_AUTH === 'true') {
            enqueue({ type: 'inventoryQuery', ts: new Date().toISOString(), source: 'auth-auto-seed' });
          }
          if (process.env.AUTO_ENQUEUE_INVENTORY_QUERY === 'true') {
            enqueue({ type: 'inventoryQuery', ts: new Date().toISOString(), source: 'auth-auto-enqueue' });
          }
        } catch (queueErr) {
          console.error('[qbwc] auto enqueue on auth failed:', queueErr);
        }
      }
      // 'none' = usar el company file actualmente abierto en QBD
      save('last-auth-response.xml',
        `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${TNS}"><soap:Body><tns:authenticateResponse><authenticateResult><string>${ticket}</string><string>none</string></authenticateResult></tns:authenticateResponse></soap:Body></soap:Envelope>`);
      cb(null, { authenticateResult: [ticket, 'none'] });
    },

    /**
     * Devuelve el siguiente QBXML pendiente en la cola (o cadena vacía si no hay trabajo).
     */
    sendRequestXML(args, cb) {
      const { qbxml } = prepareNextRequest();
      const payload = qbxml || '';
      // IMPORTANTE: node-soap se encarga del envelope, aquí solo devolver el QBXML
      cb(null, { sendRequestXMLResult: payload });
    },

    /**
     * Recibe la respuesta QBXML, la guarda y delega en el manejador común para actualizar estados/logs.
     */
    receiveResponseXML(args, cb) {
      const xml = args?.response || args?.responseXml || args?.strResponseXML || '';
      const progress = handleResponse(xml);

      // 100 = no hay más trabajo en esta sesión (0 si aún quedan jobs)
      cb(null, { receiveResponseXMLResult: progress });
    },

    getLastError(args, cb) {
      cb(null, { getLastErrorResult: '' });
    },

    closeConnection(args, cb) {
      cb(null, { closeConnectionResult: 'OK' });
    }
  };

  /**
   * Mapeos de servicio/puerto:
   * Usamos ambos nombres para ser tolerantes a variaciones del WSDL.
   * (Tu WSDL ha mostrado “QBWebConnectorSvcSoap” en los logs, así que ese puerto existe).
   */
  return {
    QBWebConnectorSvc: { QBWebConnectorSvcSoap: impl },
    QBWebConnectorSvcSoap: { QBWebConnectorSvcSoap: impl }
  };
}

module.exports = { qbwcServiceFactory };