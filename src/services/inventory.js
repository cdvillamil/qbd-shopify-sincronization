// src/services/inventory.js
//
// Builder de QBXML ultra compatible para ItemInventoryQuery.
// Mantiene la firma que ya estás usando desde index.js (buildInventoryQueryXML).
// - Versión por defecto: 16.0 (coincide con tu WC).
// - Genera CRLF (\r\n) para evitar parsers quisquillosos.
// - Consulta mínima: sin OwnerID ni ActiveStatus (se pueden añadir luego).
// - MaxReturned es opcional (se omite si es 0/null).
//
// También dejo un parser sencillo por si lo usas en otros lugares.

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatQBDateTime(input) {
  if (!input) return null;
  const dt = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(dt.valueOf())) return null;
  const datePart = [
    dt.getFullYear(),
    pad2(dt.getMonth() + 1),
    pad2(dt.getDate())
  ].join('-');
  const timePart = [
    pad2(dt.getHours()),
    pad2(dt.getMinutes()),
    pad2(dt.getSeconds())
  ].join(':');
  return `${datePart}T${timePart}`;
}

function buildInventoryQueryXML(max = 0, qbxmlVer = process.env.QBXML_VER || '16.0', options = {}) {
  const ver = String(qbxmlVer || '16.0');
  const n = Number(max) || 0;
  const opts = options || {};
  const range = opts.modifiedDateRange || {};
  const fromModifiedDate = formatQBDateTime(range.start ?? range.from);
  const toModifiedDate = formatQBDateTime(range.end ?? range.to);

  // Encabezados con CRLF y sin caracteres raros antes del XML
  const header = `<?xml version="1.0" ?><?qbxml version="${ver}"?>\r\n`;
  const openRq =
    `<QBXML>\r\n` +
    `  <QBXMLMsgsRq onError="stopOnError">\r\n` +
    `    <ItemInventoryQueryRq requestID="1">\r\n`;

  const filterLines = [];
  if (fromModifiedDate) {
    filterLines.push(`      <FromModifiedDate>${fromModifiedDate}</FromModifiedDate>\r\n`);
  }
  if (toModifiedDate) {
    filterLines.push(`      <ToModifiedDate>${toModifiedDate}</ToModifiedDate>\r\n`);
  }

  // Omitimos MaxReturned si no se especifica; si lo pasas (p.ej. 50), lo incluimos.
  const maxLine = n > 0 ? `      <MaxReturned>${n}</MaxReturned>\r\n` : '';

  const closeRq =
    `    </ItemInventoryQueryRq>\r\n` +
    `  </QBXMLMsgsRq>\r\n` +
    `</QBXML>`;

  return header + openRq + filterLines.join('') + maxLine + closeRq;
}

// Parser opcional (no cambia tu flujo actual)
function parseInventory(qbxmlText) {
  const text = qbxmlText || '';
  const blockRegex = /<ItemInventoryRet[\s\S]*?<\/ItemInventoryRet>/g;
  const tag = (src, t) => {
    const m = src.match(new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`));
    return m ? m[1] : '';
  };

  const blocks = text.match(blockRegex) || [];
  return blocks.map((b) => ({
    ListID: tag(b, 'ListID'),
    FullName: tag(b, 'FullName'),
    QuantityOnHand: Number(tag(b, 'QuantityOnHand') || 0),
  }));
}

module.exports = {
  buildInventoryQueryXML,
  parseInventory,
};