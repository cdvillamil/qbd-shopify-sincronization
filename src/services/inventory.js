// src/services/inventory.js

/**
 * Genera el QBXML para consultar inventario (Inventory Part) de forma compatible.
 * - Usa ActiveStatus=All para traer activos e inactivos.
 * - Usa MaxReturned para paginar/limitar.
 * - La versión de QBXML es configurable vía env QBXML_VER (default 13.0).
 */
function buildInventoryQueryXML(max = 10, qbxmlVer = process.env.QBXML_VER || '13.0') {
  const n = Number(max) || 10;
  const ver = String(qbxmlVer || '13.0');
  return `<?xml version="1.0"?><?qbxml version="${ver}"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <ItemInventoryQueryRq requestID="1">
      <ActiveStatus>All</ActiveStatus>
      <OwnerID>0</OwnerID>
      <MaxReturned>${n}</MaxReturned>
    </ItemInventoryQueryRq>
  </QBXMLMsgsRq>
</QBXML>`;
}

/**
 * Parser sencillo para ItemInventoryRet (por si lo quieres usar después).
 * Devuelve arreglos con ListID, FullName y QuantityOnHand.
 */
function parseInventory(qbxmlText) {
  const text = qbxmlText || '';
  const blockRegex = /<ItemInventoryRet[\s\S]*?<\/ItemInventoryRet>/g;
  const tag = (src, t) => {
    const m = src.match(new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`));
    return m ? m[1] : '';
  };

  const blocks = text.match(blockRegex) || [];
  return blocks.map(b => ({
    ListID: tag(b, 'ListID'),
    FullName: tag(b, 'FullName'),
    QuantityOnHand: Number(tag(b, 'QuantityOnHand') || 0),
  }));
}

module.exports = {
  buildInventoryQueryXML,
  parseInventory,
};