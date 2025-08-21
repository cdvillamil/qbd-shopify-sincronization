// services/inventoryParser.js
// Parser robusto SIN dependencias para convertir el QBXML (aunque venga escapado)
// en un JSON de inventario. No toca autenticación ni el flujo con QBWC.

// -------- utils --------
function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#174;/g, '®')
    .replace(/&#134;/g, '†');
}

// Toma bloques <ItemInventoryRet>...</ItemInventoryRet> (con o sin prefijo de namespace)
function getBlocks(xml, baseTag /* "ItemInventoryRet" */) {
  const re = new RegExp(
    `<\\s*(?:\\w+:)?${baseTag}\\b[\\s\\S]*?<\\/\\s*(?:\\w+:)?${baseTag}\\s*>`,
    'gi'
  );
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[0]);
  return out;
}

// Extrae el contenido de un tag (tolera prefijo de namespace)
function pick(block, tag) {
  const re = new RegExp(
    `<\\s*(?:\\w+:)?${tag}\\s*>\\s*([\\s\\S]*?)\\s*<\\/\\s*(?:\\w+:)?${tag}\\s*>`,
    'i'
  );
  const m = block.match(re);
  return m ? m[1].trim() : undefined;
}

const toNum  = (v) => (v === '' || v == null ? undefined : Number(v));
const cleanUndef = (obj) => {
  Object.keys(obj).forEach((k) => obj[k] === undefined && delete obj[k]);
  return obj;
};

// -------- main --------
/**
 * Recibe el QBXML (string) y devuelve { count, items[] }.
 * Maneja XML escapado (&lt;...&gt;) y prefijos de namespace.
 */
function parseInventoryFromQBXML(xmlInput) {
  if (typeof xmlInput !== 'string' || !xmlInput.length) {
    return { count: 0, items: [] };
  }

  // Si viene escapado (&lt;QBXML&gt;), lo desescapamos primero
  let xml = xmlInput;
  if (xml.includes('&lt;QBXML') || xml.includes('&lt;ItemInventory')) {
    xml = decodeEntities(xml);
  }

  // Si no hay señal de respuesta de inventario, devolvemos vacío
  if (!/<\s*(?:\w+:)?ItemInventory(Query)?Rs\b/i.test(xml)) {
    return { count: 0, items: [] };
  }

  // Extrae todos los <ItemInventoryRet>
  const blocks = getBlocks(xml, 'ItemInventoryRet');
  if (!blocks.length) return { count: 0, items: [] };

  const items = blocks.map((b) => {
    const Name        = pick(b, 'Name');
    const FullName    = pick(b, 'FullName');
    const BarCode     = pick(b, 'BarCodeValue') || pick(b, 'ManufacturerPartNumber');
    const SalesDesc   = pick(b, 'SalesDesc');
    const PurchaseDesc= pick(b, 'PurchaseDesc');

    const obj = {
      ListID: pick(b, 'ListID'),
      TimeCreated: pick(b, 'TimeCreated'),
      TimeModified: pick(b, 'TimeModified'),
      EditSequence: pick(b, 'EditSequence'),

      Name: Name ? decodeEntities(Name) : undefined,
      FullName: FullName ? decodeEntities(FullName) : undefined,
      BarCodeValue: BarCode ? decodeEntities(BarCode) : undefined,

      QuantityOnHand: toNum(pick(b, 'QuantityOnHand')),
      AverageCost: toNum(pick(b, 'AverageCost')),
      QuantityOnOrder: toNum(pick(b, 'QuantityOnOrder')),
      QuantityOnSalesOrder: toNum(pick(b, 'QuantityOnSalesOrder')),

      SalesDesc: SalesDesc ? decodeEntities(SalesDesc) : undefined,
      PurchaseDesc: PurchaseDesc ? decodeEntities(PurchaseDesc) : undefined,
    };

    return cleanUndef(obj);
  });

  return { count: items.length, items };
}

module.exports = {
  parseInventoryFromQBXML,
};
