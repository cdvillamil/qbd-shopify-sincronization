'use strict';

const { escapeXml, qbxmlEnvelope, refXml, addressXml, formatMoney } = require('./qbd.xmlUtils');

function optionalTag(tag, value) {
  if (value == null) return '';
  const val = typeof value === 'number' ? String(value) : String(value).trim();
  if (!val) return '';
  return `<${tag}>${escapeXml(val)}</${tag}>`;
}

function lineXml(line = {}) {
  if (!line) return '';
  const parts = [];
  const itemRef = line.ItemRef || line.itemRef || line.item || null;
  const itemXml = refXml('ItemRef', itemRef);
  if (itemXml) parts.push(itemXml);
  if (line.Desc || line.desc) parts.push(`<Desc>${escapeXml(line.Desc || line.desc)}</Desc>`);
  if (line.Quantity != null) parts.push(`<Quantity>${escapeXml(line.Quantity)}</Quantity>`);

  const rate = line.Rate != null ? line.Rate : line.rate;
  const amount = line.Amount != null ? line.Amount : line.amount;
  const rateStr = rate != null ? formatMoney(rate) : null;
  const amountStr = amount != null ? formatMoney(amount) : null;

  if (rateStr != null) parts.push(`<Rate>${rateStr}</Rate>`);
  if (amountStr != null && rateStr == null) parts.push(`<Amount>${amountStr}</Amount>`);

  const salesTaxCode = line.SalesTaxCodeRef || line.salesTaxCodeRef;
  const taxCodeXml = refXml('SalesTaxCodeRef', salesTaxCode);
  if (taxCodeXml) parts.push(taxCodeXml);

  return parts.length ? `<InvoiceLineAdd>${parts.join('')}</InvoiceLineAdd>` : '';
}

function buildInvoiceXML(payload = {}, qbxmlVer = process.env.QBXML_VER || '16.0') {
  const lines = Array.isArray(payload.lines) ? payload.lines.map(lineXml).filter(Boolean) : [];
  if (!lines.length) return '';

  const salesTaxItemXml = refXml('ItemSalesTaxRef', payload.salesTaxItem || payload.ItemSalesTaxRef);

  const body = `
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <InvoiceAddRq requestID="${escapeXml(payload.requestId || 'invoice-1')}">
      <InvoiceAdd>
        ${refXml('CustomerRef', payload.customer || payload.CustomerRef)}
        ${refXml('ClassRef', payload.classRef || payload.ClassRef)}
        ${optionalTag('TxnDate', payload.txnDate || payload.TxnDate)}
        ${optionalTag('PONumber', payload.poNumber || payload.PONumber)}
        ${optionalTag('Memo', payload.memo || payload.Memo)}
        ${refXml('ARAccountRef', payload.arAccount || payload.ARAccountRef)}
        ${addressXml('BillAddress', payload.billAddress)}
        ${addressXml('ShipAddress', payload.shipAddress)}
        ${salesTaxItemXml || ''}
        ${lines.join('')}
      </InvoiceAdd>
    </InvoiceAddRq>
  </QBXMLMsgsRq>
</QBXML>`;

  return qbxmlEnvelope(body, qbxmlVer);
}

module.exports = { buildInvoiceXML };
