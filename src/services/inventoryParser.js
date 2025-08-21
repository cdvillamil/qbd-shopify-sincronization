// services/inventoryParser.js
// Parser liviano SIN dependencias para convertir el QBXML de /debug/last-response a un JSON de inventario.
// Mantiene cambios mínimos y cero riesgo sobre autenticación o flujo del WC.

function textBetween(tag, block) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : undefined;
}

function getBlocks(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

// Decodifica unas entidades básicas comunes en QBXML para que el JSON sea legible.
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

/**
 * Recibe el QBXML completo (string) y devuelve { count, items[] }
 * Campos comunes expuestos: ListID, Name, FullName, BarCodeValue, QuantityOnHand, AverageCost,
 * QuantityOnOrder, QuantityOnSalesOrder, TimeCreated, TimeModified, SalesDesc, PurchaseDesc
 */
function parseInventoryFromQBXML(xml) {
  if (typeof xml !== 'string' || !xml.includes('<ItemInventoryQueryRs')) {
    return { count: 0, items: [] };
  }

  // Extrae todos los bloques de <ItemInventoryRet> ... </ItemInventoryRet>
  const itemBlocks = getBlocks(xml, 'ItemInventoryRet');
  const items = itemBlocks.map(block => {
    const obj = {
      ListID: textBetween('ListID', block),
      TimeCreated: textBetween('TimeCreated', block),
      TimeModified: textBetween('TimeModified', block),
      EditSequence: textBetween('EditSequence', block),
      Name: decodeEntities(textBetween('Name', block)),
      FullName: decodeEntities(textBetween('FullName', block)),
      BarCodeValue: decodeEntities(textBetween('BarCodeValue', block) || textBetween('ManufacturerPartNumber', block)),
      QuantityOnHand: textBetween('QuantityOnHand', block) ? Number(textBetween('QuantityOnHand', block)) : undefined,
      AverageCost: textBetween('AverageCost', block) ? Number(textBetween('AverageCost', block)) : undefined,
      QuantityOnOrder: textBetween('QuantityOnOrder', block) ? Number(textBetween('QuantityOnOrder', block)) : undefined,
      QuantityOnSalesOrder: textBetween('QuantityOnSalesOrder', block) ? Number(textBetween('QuantityOnSalesOrder', block)) : undefined,
      SalesDesc: decodeEntities(textBetween('SalesDesc', block)),
      PurchaseDesc: decodeEntities(textBetween('PurchaseDesc', block)),
    };
    // Limpia undefined para que la salida sea prolija
    Object.keys(obj).forEach(k => obj[k] === undefined && delete obj[k]);
    return obj;
  });

  return { count: items.length, items };
}

module.exports = {
  parseInventoryFromQBXML,
};
