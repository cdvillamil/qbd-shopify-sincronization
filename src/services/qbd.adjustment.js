// src/services/qbd.adjustment.js

function esc(s) {
  return String(s).replace(/[<>&'\"]/g, (ch) => (
    ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch === "'" ? '&apos;' : '&quot;'
  ));
}

function resolveRef(ref) {
  if (ref == null) return null;
  if (typeof ref === 'string') {
    const str = ref.trim();
    if (!str) return null;
    return { tag: 'FullName', value: str };
  }
  if (typeof ref !== 'object') return null;

  const listId =
    ref.ListID ??
    ref.listId ??
    ref.listID ??
    null;
  if (listId != null && listId !== '') {
    return { tag: 'ListID', value: String(listId) };
  }

  const fullName =
    ref.FullName ??
    ref.fullName ??
    ref.Name ??
    ref.name ??
    null;
  if (fullName != null && String(fullName).trim()) {
    return { tag: 'FullName', value: String(fullName).trim() };
  }

  return null;
}

function renderRefBlock(wrapperTag, ref) {
  const resolved = resolveRef(ref);
  if (!resolved) return '';
  return `<${wrapperTag}><${resolved.tag}>${esc(resolved.value)}</${resolved.tag}></${wrapperTag}>`;
}

function normalizeLine(line) {
  if (!line || typeof line !== 'object') return null;

  const itemRef = renderRefBlock('ItemRef', line);
  if (!itemRef) return null;

  const rawQty =
    line.QuantityDifference ??
    line.quantityDifference ??
    line.Quantity ??
    line.quantity ??
    null;
  const qty = Number(rawQty);
  if (!Number.isFinite(qty) || qty === 0) return null;

  const parts = [itemRef];

  const siteRefBlock = renderRefBlock('InventorySiteRef', line.InventorySiteRef);
  if (siteRefBlock) parts.push(siteRefBlock);

  const siteLocationBlock = renderRefBlock(
    'InventorySiteLocationRef',
    line.InventorySiteLocationRef
  );
  if (siteLocationBlock) parts.push(siteLocationBlock);

  parts.push(
    `<QuantityAdjustment>
          <QuantityDifference>${qty}</QuantityDifference>
        </QuantityAdjustment>`
  );

  return `
      <InventoryAdjustmentLineAdd>
        ${parts.join('\n        ')}
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
