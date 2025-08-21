'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Parser } = require('xml2js');

const LOG_DIR = '/tmp';
const JOBS_PATH = path.join(LOG_DIR, 'jobs.json');
const LAST_REQ_QBXML = path.join(LOG_DIR, 'last-request-qbxml.xml');
const LAST_RESP_XML = path.join(LOG_DIR, 'last-response.xml');
const LAST_RESP_XML_TS = () => path.join(LOG_DIR, `last-response-${Date.now()}.xml`);
const LAST_INVENTORY = path.join(LOG_DIR, 'last-inventory.json');
const LAST_POST = path.join(LOG_DIR, 'last-post-body.xml');
const LAST_AUTH_REQ = path.join(LOG_DIR, 'last-auth-request.xml');
const LAST_AUTH_RESP = path.join(LOG_DIR, 'last-auth-response.xml');
const LAST_AUTH_CRED = path.join(LOG_DIR, 'last-auth-cred.json');

const WC_USER = process.env.WC_USERNAME || '';
const WC_PASS = process.env.WC_PASSWORD || '';
const HAS_ADV_INV = (process.env.HAS_ADV_INV || '').toString() === '1';

/* ---------------------------- utilidades básicas --------------------------- */

function safeWrite(file, data) {
  try { fs.writeFileSync(file, data, 'utf8'); } catch { /* no-op */ }
}
function safeJson(file, obj) { safeWrite(file, JSON.stringify(obj, null, 2)); }
function readJobs() {
  try { return JSON.parse(fs.readFileSync(JOBS_PATH, 'utf8')); } catch { return []; }
}
function writeJobs(arr) { safeJson(JOBS_PATH, Array.isArray(arr) ? arr : []); }

function sha256(s) { return crypto.createHash('sha256').update(s || '').digest('hex'); }

/* --------------------------- construcción de QBXML ------------------------- */

function buildInventoryQueryQBXML(max = 100) {
  const header = '<?xml version="1.0"?><?qbxml version="16.0"?>';
  const inv = `
    <ItemInventoryQueryRq requestID="inv-1">
      <OwnerID>0</OwnerID>
      <MaxReturned>${max}</MaxReturned>
      <ActiveStatus>All</ActiveStatus>
    </ItemInventoryQueryRq>`;
  const asm = `
    <ItemInventoryAssemblyQueryRq requestID="asm-1">
      <OwnerID>0</OwnerID>
      <MaxReturned>${max}</MaxReturned>
      <ActiveStatus>All</ActiveStatus>
    </ItemInventoryAssemblyQueryRq>`;
  // Solo pedir ItemSites si el company tiene Advanced Inventory
  const sites = HAS_ADV_INV ? `
    <ItemSitesQueryRq requestID="sites-1">
      <ActiveStatus>All</ActiveStatus>
      <OwnerID>0</OwnerID>
      <MaxReturned>${max}</MaxReturned>
    </ItemSitesQueryRq>` : '';

  const body = `<QBXML><QBXMLMsgsRq onError="stopOnError">${inv}${asm}${sites}</QBXMLMsgsRq></QBXML>`;
  const qbxml = header + body;
  safeWrite(LAST_REQ_QBXML, qbxml);
  return qbxml;
}

/* ---------------------------- parser de respuestas ------------------------- */

// xml2js configurado para conservar atributos y arrays
const parser = new Parser({ explicitArray: false, ignoreAttrs: false, mergeAttrs: true });

// Recolector genérico que busca Ret de inventario en cualquier respuesta
function collectInventoryFromRs(rsNode, acc) {
  if (!rsNode || typeof rsNode !== 'object') return;

  // ItemInventoryQueryRs -> ItemInventoryRet
  if (rsNode.ItemInventoryRet) {
    const list = Array.isArray(rsNode.ItemInventoryRet) ? rsNode.ItemInventoryRet : [rsNode.ItemInventoryRet];
    list.forEach((it) => acc.push({ Type: 'ItemInventoryRet', ...it }));
  }

  // ItemInventoryAssemblyQueryRs -> ItemInventoryAssemblyRet
  if (rsNode.ItemInventoryAssemblyRet) {
    const list = Array.isArray(rsNode.ItemInventoryAssemblyRet) ? rsNode.ItemInventoryAssemblyRet : [rsNode.ItemInventoryAssemblyRet];
    list.forEach((it) => acc.push({ Type: 'ItemInventoryAssemblyRet', ...it }));
  }

  // ItemSitesQueryRs -> ItemSitesRet (solo si hay Advanced Inventory)
  if (rsNode.ItemSitesRet) {
    const list = Array.isArray(rsNode.ItemSitesRet) ? rsNode.ItemSitesRet : [rsNode.ItemSitesRet];
    list.forEach((it) => acc.push({ Type: 'ItemSitesRet', ...it }));
  }

  // Algunos QB devuelven ItemQueryRs con ItemRet y Type
  if (rsNode.ItemRet) {
    const list = Array.isArray(rsNode.ItemRet) ? rsNode.ItemRet : [rsNode.ItemRet];
    list.forEach((it) => {
      const t = it.Type || '';
      if (/Inventory/i.test(t) || /Assembly/i.test(t)) acc.push({ Type: `ItemRet:${t}`, ...it });
    });
  }
}

async function parseAndStoreInventory(xml) {
  safeWrite(LAST_RESP_XML, xml);
  safeWrite(LAST_RESP_XML_TS(), xml);

  const js = await parser.parseStringPromise(xml).catch(() => null);
  const out = [];

  const msgs = js?.QBXML?.QBXMLMsgsRs;
  if (!msgs) {
    safeJson(LAST_INVENTORY, { count: 0, items: [] });
    return { count: 0, items: [] };
  }

  // msgs puede ser objeto con múltiples *Rs
  const rsKeys = Object.keys(msgs);
  rsKeys.forEach((k) => {
    const node = msgs[k];
    if (Array.isArray(node)) node.forEach((n) => collectInventoryFromRs(n, out));
    else collectInventoryFromRs(node, out);
  });

  // Normaliza campos básicos para inspección rápida
  const normalized = out.map((it) => {
    const base = {
      Type: it.Type,
      ListID: it.ListID || it.ItemInventoryRef?.ListID || null,
      FullName: it.FullName || it.Name || it.ItemInventoryRef?.FullName || null,
      EditSequence: it.EditSequence || null,
    };
    // Cantidades (distintos nombres según tipo)
    const qoh = it.QuantityOnHand ?? it.OnHand ?? null;
    const qavail = it.QuantityOnHandAvailable ?? it.QuantityOnOrder ?? null;
    return { ...base, QuantityOnHand: qoh, QuantityAvailableOrOnOrder: qavail, raw: it };
  });

  safeJson(LAST_INVENTORY, { count: normalized.length, items: normalized });
  return { count: normalized.length, items: normalized };
}

/* -------------------------- servicio SOAP (factory) ------------------------ */

function qbwcServiceFactory() {
  // ¡NO toques authenticate! — mantiene el mismo comportamiento
  const svc = {
    QBWebConnectorSvcSoap: {
      QBWebConnectorSvcSoap: {
        serverVersion(args, cb) {
          cb(null, { serverVersionResult: '1.0.0-dev' });
        },
        clientVersion(args, cb) {
          cb(null, { clientVersionResult: '' }); // acepta cualquier WC
        },

        // Mantén la autenticación tal como estaba
        authenticate(args, cb) {
          const user = (args?.strUserName || '').trim();
          const pass = args?.strPassword || '';

          // auditoría
          safeWrite(LAST_AUTH_REQ, JSON.stringify({ Body: { authenticate: { strUserName: user, strPassword: pass } } }, null, 2));

          const matchUser = user === WC_USER;
          const matchPass = pass === WC_PASS;

          safeJson(LAST_AUTH_CRED, {
            ts: new Date().toISOString(),
            receivedUser: user,
            receivedPassLen: pass.length,
            receivedPassSha256: sha256(pass),
            envUser: WC_USER,
            envPassLen: WC_PASS.length,
            envPassSha256: sha256(WC_PASS),
            matchUser,
            matchPassHash: matchPass
          });

          if (!matchUser || !matchPass) {
            // Señaliza fallo estándar
            const envelope = `<?xml version="1.0" encoding="utf-8"?>
              <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://developer.intuit.com/">
                <soap:Body><tns:authenticateResponse>
                  <authenticateResult><string></string><string>nvu</string></authenticateResult>
                </tns:authenticateResponse></soap:Body>
              </soap:Envelope>`;
            safeWrite(LAST_AUTH_RESP, envelope);
            return cb(null, { authenticateResult: ['', 'nvu'] });
          }

          const ticket = crypto.randomUUID();
          // devuelve el ticket y (opcional) CompanyFile; dejamos vacío para usar el abierto
          const envelope = `<?xml version="1.0" encoding="utf-8"?>
            <soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://developer.intuit.com/">
              <soap:Body><tns:authenticateResponse>
                <authenticateResult><string>${ticket}</string><string>none</string></authenticateResult>
              </tns:authenticateResponse></soap:Body>
            </soap:Envelope>`;
          safeWrite(LAST_AUTH_RESP, envelope);
          cb(null, { authenticateResult: [ticket, 'none'] });
        },

        // Devuelve QBXML sólo si hay trabajo pendiente
        sendRequestXML(args, cb) {
          const jobs = readJobs();
          const job = jobs[0];

          // guarda el POST crudo si WC lo envía (no siempre viene aquí)
          if (args && typeof args === 'object') {
            try { safeWrite(LAST_POST, JSON.stringify(args, null, 2)); } catch {}
          }

          if (!job) {
            // Nada que hacer → cadena vacía = 0% trabajo pendiente
            return cb(null, { sendRequestXMLResult: '' });
          }

          if (job.type === 'inventoryQuery') {
            const max = Number(job.max || 100) || 100;
            const qbxml = buildInventoryQueryQBXML(max);
            // consumimos el job
            jobs.shift();
            writeJobs(jobs);
            return cb(null, { sendRequestXMLResult: qbxml });
          }

          // Tipo desconocido → no hacer nada
          return cb(null, { sendRequestXMLResult: '' });
        },

        // Parsea la respuesta; devuelve el % restante
        receiveResponseXML(args, cb) {
          const xml = args?.response ?? args?.responseXml ?? args?.strResponseXML ?? '';
          const percent = Number(args?.hresult || 0); // WC no siempre lo usa; ignoramos

          safeWrite(LAST_RESP_XML, xml);
          safeWrite(LAST_RESP_XML_TS(), xml);

          // Intenta parsear; si falla, no bloqueamos el ciclo
          parseAndStoreInventory(xml)
            .then(({ count }) => {
              // 100 = no más trabajo en esta sesión
              cb(null, { receiveResponseXMLResult: 100 });
            })
            .catch(() => cb(null, { receiveResponseXMLResult: 100 }));
        },

        getLastError(args, cb) {
          cb(null, { getLastErrorResult: '' });
        },

        closeConnection(args, cb) {
          cb(null, { closeConnectionResult: 'OK' });
        }
      }
    }
  };

  return svc;
}

module.exports = { qbwcServiceFactory };
