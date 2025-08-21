// qbwcService.js
// — Consulta de inventario (ItemInventoryQueryRq con iterator) + rutas de debug —
// Requiere: npm i fast-xml-parser@4

const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const DATA_DIR = path.join(__dirname, 'data');
const INVENTORY_PATH = path.join(DATA_DIR, 'inventory.json');
const DEBUG_PATH = path.join(DATA_DIR, 'lastResponse.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: true,
});

const state = {
  // Control de la sesión del WC
  started: false,
  step: null,           // 'INV_START' | 'INV_CONT' | null
  iteratorID: null,

  // Datos de depuración
  lastRequestXml: null,
  lastResponseXml: null,
  updatedAt: null,

  // Inventario en memoria
  inventory: [],
};

// Helpers de persistencia
function saveDebug() {
  const payload = {
    updatedAt: new Date().toISOString(),
    lastRequestXml: state.lastRequestXml,
    lastResponseXml: state.lastResponseXml,
  };
  try {
    fs.writeFileSync(DEBUG_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (_) {}
}

function saveInventory() {
  const payload = {
    updatedAt: new Date().toISOString(),
    count: state.inventory.length,
    items: state.inventory,
  };
  try {
    fs.writeFileSync(INVENTORY_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (_) {}
}

function loadInventoryFromDisk() {
  try {
    if (fs.existsSync(INVENTORY_PATH)) {
      const raw = fs.readFileSync(INVENTORY_PATH, 'utf8');
      const json = JSON.parse(raw);
      state.inventory = Array.isArray(json.items) ? json.items : [];
    }
  } catch (_) {
    // si falla, dejamos inventory en []
  }
}

// Helpers de parsing y tipos
const toNum = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const toBool = (v) => String(v).toLowerCase() === 'true';

// ==========================
// QBXML builders
// ==========================
const QBXML_HEADER = `<?xml version="1.0" encoding="utf-8"?>\n<?qbxml version="13.0"?>`;

function buildItemInventoryQueryStart() {
  // Primer batch con iterator="Start"
  return `${QBXML_HEADER}
<QBXML>
  <QBXMLMsgsRq onError="continueOnError">
    <ItemInventoryQueryRq requestID="inv-1" iterator="Start">
      <ActiveStatus>All</ActiveStatus>
      <OwnerID>0</OwnerID>
      <IncludeRetElement>ListID</IncludeRetElement>
      <IncludeRetElement>FullName</IncludeRetElement>
      <IncludeRetElement>IsActive</IncludeRetElement>
      <IncludeRetElement>SalesDesc</IncludeRetElement>
      <IncludeRetElement>SalesPrice</IncludeRetElement>
      <IncludeRetElement>PurchaseCost</IncludeRetElement>
      <IncludeRetElement>QuantityOnHand</IncludeRetElement>
    </ItemInventoryQueryRq>
  </QBXMLMsgsRq>
</QBXML>`;
}

function buildItemInventoryQueryContinue(iteratorID) {
  return `${QBXML_HEADER}
<QBXML>
  <QBXMLMsgsRq onError="continueOnError">
    <ItemInventoryQueryRq requestID="inv-cont" iterator="Continue" iteratorID="${iteratorID}">
      <OwnerID>0</OwnerID>
    </ItemInventoryQueryRq>
  </QBXMLMsgsRq>
</QBXML>`;
}

// ==========================
// Public API esperada por tu SOAP server
// ==========================

// IMPORTANTE: no cambiamos la lógica de auth; asumimos que tu SOAP server ya la maneja.
// Aquí solo arrancamos la “tarea” de inventario cuando el WC entra al ciclo de requests.
function sendRequestXML() {
  // Si no se ha iniciado la sesión, preparamos el primer paso
  if (!state.started) {
    state.started = true;
    state.step = 'INV_START';
    state.iteratorID = null;
    state.inventory = []; // limpiamos para refrescar
  }

  let qbxml = '';

  if (state.step === 'INV_START') {
    qbxml = buildItemInventoryQueryStart();
  } else if (state.step === 'INV_CONT' && state.iteratorID) {
    qbxml = buildItemInventoryQueryContinue(state.iteratorID);
  } else {
    // No hay más trabajo; devolvemos cadena vacía
    qbxml = '';
    // Al retornar vacío, el WC llamará a closeConnection
  }

  state.lastRequestXml = qbxml || '(no more work)';
  state.updatedAt = new Date().toISOString();
  saveDebug();

  return qbxml;
}

function receiveResponseXML(qbResponseXml /*, hresult, message */) {
  // Guardamos la respuesta cruda para debug
  state.lastResponseXml = qbResponseXml;
  state.updatedAt = new Date().toISOString();

  // Parse básico
  let remaining = 0;
  let nextIteratorID = null;
  try {
    const json = parser.parse(qbResponseXml);
    const msgs = json?.QBXML?.QBXMLMsgsRs;
    const rs = msgs?.ItemInventoryQueryRs;

    if (rs) {
      // iteratorRemainingCount / iteratorID
      remaining = Number(rs?.iteratorRemainingCount || 0);
      nextIteratorID = rs?.iteratorID || null;

      // ItemInventoryRet puede ser objeto o arreglo
      const rets = rs?.ItemInventoryRet
        ? Array.isArray(rs.ItemInventoryRet)
          ? rs.ItemInventoryRet
          : [rs.ItemInventoryRet]
        : [];

      const mapped = rets.map((r) => ({
        ListID: r.ListID ?? null,
        FullName: r.FullName ?? null,
        IsActive: toBool(r.IsActive),
        SalesDesc: r.SalesDesc ?? null,
        SalesPrice: toNum(r.SalesPrice),
        PurchaseCost: toNum(r.PurchaseCost),
        QuantityOnHand: toNum(r.QuantityOnHand),
      }));

      if (mapped.length) {
        state.inventory.push(...mapped);
        saveInventory(); // vamos grabando en disco por si el WC corta
      }
    }
  } catch (err) {
    // Si hay error de parseo, igual persistimos el raw
  } finally {
    saveDebug();
  }

  if (remaining > 0 && nextIteratorID) {
    // Aún falta; pedimos otro batch
    state.step = 'INV_CONT';
    state.iteratorID = nextIteratorID;

    // Indicamos al WC que todavía no terminamos (cualquier número < 100 sirve)
    return 0; // 0% done -> sigue llamando a sendRequestXML
  }

  // Listo, no hay más resultados
  state.step = null;
  state.iteratorID = null;
  state.started = false;

  // 100 = finished
  return 100;
}

function closeConnection() {
  // Puedes registrar logs aquí si lo necesitas
  return 'OK';
}

// ==========================
// Endpoints de apoyo (usados por /debug/*)
// ==========================
function getDebugInfo() {
  // Intenta leer del archivo para que incluso tras reinicios tengamos algo
  let disk = {};
  try {
    if (fs.existsSync(DEBUG_PATH)) {
      disk = JSON.parse(fs.readFileSync(DEBUG_PATH, 'utf8'));
    }
  } catch (_) {}
  return {
    updatedAt: state.updatedAt || disk.updatedAt || null,
    lastRequestXml: state.lastRequestXml || disk.lastRequestXml || null,
    lastResponseXml: state.lastResponseXml || disk.lastResponseXml || null,
  };
}

function getInventory() {
  // Sincroniza con disco si el array está vacío (p.ej. tras reinicio)
  if (state.inventory.length === 0) {
    loadInventoryFromDisk();
  }
  return {
    count: state.inventory.length,
    items: state.inventory,
  };
}

// (Opcional) limpiar cache de inventario manualmente
function resetInventory() {
  state.inventory = [];
  saveInventory();
}

// Export público
module.exports = {
  // Ciclo de WC
  sendRequestXML,
  receiveResponseXML,
  closeConnection,

  // Debug/consulta
  getDebugInfo,
  getInventory,
  resetInventory,
};