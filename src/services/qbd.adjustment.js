// src/services/qbd.adjustment.js
function esc(s) {
  return String(s).replace(/[<>&'"]/g, (ch) => (
    ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch === "'" ? '&apos;' : '&quot;'
  ));
}

function lineXml(l) {
  const ref = l.ListID
    ? `<ListID>${esc(l.ListID)}</ListID>`
    : `<FullName>${esc(l.FullName)}</FullName>`;
  const q = Number(l.QuantityDifference || 0);
  return `
      <InventoryAdjustmentLineAdd>
        <ItemRef>${ref}</ItemRef>
        <QuantityAdjustment>
          <QuantityDifference>${q}</QuantityDifference>
        </QuantityAdjustment>
      </InventoryAdjustmentLineAdd>`;
}

function buildInventoryAdjustmentXML(lines = [], accountName, qbxmlVer = process.env.QBXML_VER || '16.0') {
  const ver = String(qbxmlVer || '16.0');
  const account = accountName || process.env.QBD_ADJUST_ACCOUNT || 'Inventory Adjustment';
  const header = `<?xml version="1.0" ?><?qbxml version="${ver}"?>\r\n`;
  const body = `
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <InventoryAdjustmentAddRq requestID="adj-1">
      <InventoryAdjustmentAdd>
        <AccountRef><FullName>${esc(account)}</FullName></AccountRef>
        ${lines.map(lineXml).join('')}
      </InventoryAdjustmentAdd>
    </InventoryAdjustmentAddRq>
  </QBXMLMsgsRq>
</QBXML>`;
  return header + body;
}

module.exports = { buildInventoryAdjustmentXML };