// src/services/qbd.adjustment.js

function esc(s) {
  return String(s).replace(/[<>&'\"]/g, (ch) => (
    ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch === "'" ? '&apos;' : '&quot;'
  ));
}

function normalizeLine(line) {
  if (!line || typeof line !== 'object') return null;

  const hasListId = line.ListID != null && line.ListID !== '';
  const rawRef = hasListId ? line.ListID : line.FullName || line.Name;
  if (!rawRef) return null;

  const rawQty =
    line.QuantityDifference ??
    line.quantityDifference ??
    line.Quantity ??
    line.quantity ??
    null;
  const qty = Number(rawQty);
  if (!Number.isFinite(qty) || qty === 0) return null;

  const ref = hasListId
    ? `<ListID>${esc(rawRef)}</ListID>`
    : `<FullName>${esc(rawRef)}</FullName>`;

  return `
      <InventoryAdjustmentLineAdd>
        <ItemRef>${ref}</ItemRef>
        <QuantityAdjustment>
          <QuantityDifference>${qty}</QuantityDifference>
        </QuantityAdjustment>
      </InventoryAdjustmentLineAdd>`;
}

function buildInventoryAdjustmentXML(
  lines = [],
  accountName,
  qbxmlVer = process.env.QBXML_VER || '16.0'
) {
  const ver = String(qbxmlVer || '16.0');
  const account = accountName || process.env.QBD_ADJUST_ACCOUNT || 'Inventory Adjustment';
  const validLines = (Array.isArray(lines) ? lines : [])
    .map((line) => normalizeLine(line))
    .filter(Boolean);

  if (!validLines.length) return '';

  const header = `<?xml version="1.0" ?><?qbxml version="${ver}"?>\r\n`;
  const body = `
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <InventoryAdjustmentAddRq requestID="adj-1">
      <InventoryAdjustmentAdd>
        <AccountRef><FullName>${esc(account)}</FullName></AccountRef>
        ${validLines.join('')}
      </InventoryAdjustmentAdd>
    </InventoryAdjustmentAddRq>
  </QBXMLMsgsRq>
</QBXML>`;
  return header + body;
}

module.exports = { buildInventoryAdjustmentXML };
