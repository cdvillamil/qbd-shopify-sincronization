// src/services/qbwcService.js
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LOG_DIR, ensureDir: ensureLogDir } = require('./jobQueue');

/**
 * OBJETIVO
 * - Mantener authenticate EXACTO (usuario/contraseña desde variables de entorno).
 * - Implementar sendRequestXML para que SIEMPRE devuelva un QBXML de inventario (pull bajo demanda en cada corrida).
 * - Implementar receiveResponseXML para parsear ItemInventory, ItemInventoryAssembly y (si aplica) ItemSites (Advanced Inventory).
 * - Guardar archivos de depuración en LOG_DIR para validar fácilmente desde tus endpoints actuales (/debug/*).
 *
 * No agrega dependencias y no requiere cambios en index.js ni en el WSDL.
 */

/* =========================
   Configuración y helpers
   ========================= */
const HAS_ADV_INV = (process.env.HAS_ADV_INV || '').toString() === '1'; // 1 si tu QBD tiene Advanced Inventory
const QB_MAX = Number(process.env.QB_MAX || 200) || 200;                // límite de ítems a pedir en cada tipo
const TNS = 'http://developer.intuit.com/';

const APP_USER = process.env.WC_USERNAME || '';
const APP_PASS = process.env.WC_PASSWORD || '';

function save(name, txt) { ensureLogDir(); fs.writeFileSync(path.join(LOG_DIR, name), txt ?? '', 'utf8'); }
function read(name) { try { return fs.readFileSync(path.join(LOG_DIR, name), 'utf8'); } catch { return null; } }
function sha256(s) { return crypto.createHash('sha256').update(s || '').digest('hex'); }

/* =========================
   Construcción de QBXML
   ========================= */
function buildInventoryQBXML(max = QB_MAX) {
  const inv = `
    <ItemInventoryQueryRq requestID="1">
      <ActiveStatus>All</ActiveStatus>
      <OwnerID>0</OwnerID>
      <MaxReturned>${max}</MaxReturned>
    </ItemInventoryQueryRq>`;

  const asm = `
    <ItemInventoryAssemblyQueryRq requestID="2">
      <ActiveStatus>All</ActiveStatus>
      <OwnerID>0</OwnerID>
      <MaxReturned>${max}</MaxReturned>
    </ItemInventoryAssemblyQueryRq>`;

  const sites = HAS_ADV_INV ? `
    <ItemSitesQueryRq requestID="3">
      <ActiveStatus>All</ActiveStatus>
      <OwnerID>0</OwnerID>
      <MaxReturned>${max}</MaxReturned>
    </ItemSitesQueryRq>` : '';

  const qbxml = `<?xml version="1.0"?><?qbxml version="16.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    ${inv}${asm}${sites}
  </QBXMLMsgsRq>
</QBXML>`;

  save('last-request-qbxml.xml', qbxml);
  return qbxml;
}

/* =========================
   Parser simple (sin libs)
   ========================= */
// Matchea bloques <Tag> ... </Tag> incluso multi-línea
function blocks(xml, tag) {
  return xml.match(new RegExp(`<${tag}[\\s\\S]*?<\\/${tag}>`, 'g')) || [];
}
// Extrae el contenido de <tag>valor</tag>
function val(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1] : '';
}

function parseInventory(qbxml) {
  const out = [];

  // Ítems de inventario
  for (const b of blocks(qbxml, 'ItemInventoryRet')) {
    out.push({
      Type: 'ItemInventoryRet',
      ListID: val(b, 'ListID') || null,
      FullName: val(b, 'FullName') || val(b, 'Name') || null,
      QuantityOnHand: Number(val(b, 'QuantityOnHand') || 0),
      EditSequence: val(b, 'EditSequence') || null
    });
  }

  // Ensambles de inventario
  for (const b of blocks(qbxml, 'ItemInventoryAssemblyRet')) {
    out.push({
      Type: 'ItemInventoryAssemblyRet',
      ListID: val(b, 'ListID') || null,
      FullName: val(b, 'FullName') || val(b, 'Name') || null,
      QuantityOnHand: Number(val(b, 'QuantityOnHand') || 0),
      EditSequence: val(b, 'EditSequence') || null
    });
  }

  // Niveles por sitio (si hay Advanced Inventory)
  for (const b of blocks(qbxml, 'ItemSitesRet')) {
    const itemRef = (b.match(/<ItemInventoryRef>[\\s\\S]*?<\\/ItemInventoryRef>/i) || [null])[0]
                 || (b.match(/<ItemRef>[\\s\\S]*?<\\/ItemRef>/i) || [null])[0] || '';
    const siteRef = (b.match(/<SiteRef>[\\s\\S]*?<\\/SiteRef>/i) || [null])[0] || '';
    out.push({
      Type: 'ItemSitesRet',
      ItemFullName: val(itemRef, 'FullName') || null,
      SiteFullName: val(siteRef, 'FullName') || null,
      QuantityOnHand: Number(val(b, 'QuantityOnHand') || 0)
    });
  }

  return out;
}

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
      // 'none' = usar el company file actualmente abierto en QBD
      save('last-auth-response.xml',
        `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="${TNS}"><soap:Body><tns:authenticateResponse><authenticateResult><string>${ticket}</string><string>none</string></authenticateResult></tns:authenticateResponse></soap:Body></soap:Envelope>`);
      cb(null, { authenticateResult: [ticket, 'none'] });
    },

    /**
     * Devuelve QBXML de inventario en cada corrida.
     * (Si prefieres “bajo demanda”, aquí se podría leer un trigger/cola; por simplicidad, lo enviamos siempre).
     */
    sendRequestXML(args, cb) {
      const qbxml = buildInventoryQBXML(QB_MAX);
      const stamp = new Date().toISOString();
      const logBlock = [
        `[${stamp}] [qbwcService] sendRequestXML qbXML BEGIN`,
        qbxml,
        `[${stamp}] [qbwcService] sendRequestXML qbXML END`
      ].join('\n');
      if (process.stdout && typeof process.stdout.write === 'function') {
        process.stdout.write(`${logBlock}\n`);
      } else {
        console.log(logBlock);
      }
      // IMPORTANTE: node-soap se encarga del envelope, aquí solo devolver el QBXML
      cb(null, { sendRequestXMLResult: qbxml });
    },

    /**
     * Recibe la respuesta QBXML, la guarda y la parsea a JSON consolidado en LOG_DIR/last-inventory.json
     */
    receiveResponseXML(args, cb) {
      const xml = args?.response || args?.responseXml || args?.strResponseXML || '';
      const stamp = new Date().toISOString();
      const logBlock = [
        `[${stamp}] [qbwcService] receiveResponseXML qbXML BEGIN`,
        xml,
        `[${stamp}] [qbwcService] receiveResponseXML qbXML END`
      ].join('\n');
      if (process.stdout && typeof process.stdout.write === 'function') {
        process.stdout.write(`${logBlock}\n`);
      } else {
        console.log(logBlock);
      }
      save(`last-response-${Date.now()}.xml`, xml);
      save('last-response.xml', xml);

      const items = parseInventory(xml);
      save('last-inventory.json', JSON.stringify({ count: items.length, items }, null, 2));

      // 100 = no hay más trabajo en esta sesión
      cb(null, { receiveResponseXMLResult: 100 });
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