'use strict';

const { escapeXml, qbxmlEnvelope, itemRefXml, refXml, addressXml, formatMoney } = require('./qbd.xmlUtils');

function optionalTag(tag, value) {
  if (value == null) return '';
  const val = typeof value === 'number' ? String(value) : String(value).trim();
  if (!val) return '';
  return `<${tag}>${escapeXml(val)}</${tag}>`;
}

function optionalBool(tag, value) {
  if (value == null) return '';
  return `<${tag}>${value ? 'true' : 'false'}</${tag}>`;
}

function lineXml(line = {}) {
  if (!line) return '';
  const parts = [];
  const itemXml = itemRefXml(line.ItemRef || line.itemRef || line.item || {});
  if (itemXml) parts.push(itemXml);
  if (line.Desc || line.desc) parts.push(`<Desc>${escapeXml(line.Desc || line.desc)}</Desc>`);
  if (line.Quantity != null) parts.push(`<Quantity>${escapeXml(line.Quantity)}</Quantity>`);
  const rate = line.Rate != null ? line.Rate : line.rate;
  const amount = line.Amount != null ? line.Amount : line.amount;
  const rateStr = rate != null ? formatMoney(rate) : null;
  const amountStr = amount != null ? formatMoney(amount) : null;
  if (rateStr != null) parts.push(`<Rate>${rateStr}</Rate>`);
  if (amountStr != null && rateStr == null) parts.push(`<Amount>${amountStr}</Amount>`);
  if (line.SalesTaxCodeRef) parts.push(refXml('SalesTaxCodeRef', line.SalesTaxCodeRef));
  if (line.ClassRef) parts.push(refXml('ClassRef', line.ClassRef));
  if (line.ServiceDate) parts.push(`<ServiceDate>${escapeXml(line.ServiceDate)}</ServiceDate>`);
  return parts.length ? `<InvoiceLineAdd>${parts.join('')}</InvoiceLineAdd>` : '';
}

function buildInvoiceXML(payload = {}, qbxmlVer = process.env.QBXML_VER || '16.0') {
  const lines = Array.isArray(payload.lines) ? payload.lines.map(lineXml).filter(Boolean) : [];
  if (!lines.length) return '';

  const body = `
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <InvoiceAddRq requestID="invoice-1">
      <InvoiceAdd>
        ${refXml('CustomerRef', payload.customer || payload.CustomerRef)}
        ${refXml('ClassRef', payload.ClassRef)}
        ${refXml('ARAccountRef', payload.ARAccountRef)}
        ${refXml('TemplateRef', payload.TemplateRef)}
        ${optionalTag('TxnDate', payload.txnDate || payload.TxnDate)}
        ${optionalTag('RefNumber', payload.refNumber || payload.RefNumber)}
        ${optionalTag('PONumber', payload.poNumber || payload.PONumber)}
        ${optionalTag('DueDate', payload.dueDate || payload.DueDate)}
        ${optionalTag('ShipDate', payload.shipDate || payload.ShipDate)}
        ${refXml('ShipMethodRef', payload.ShipMethodRef)}
        ${optionalTag('Memo', payload.memo || payload.Memo)}
        ${optionalBool('IsPending', payload.isPending ?? payload.IsPending)}
        ${addressXml('BillAddress', payload.billAddress || payload.BillAddress)}
        ${addressXml('ShipAddress', payload.shipAddress || payload.ShipAddress)}
        ${lines.join('')}
      </InvoiceAdd>
    </InvoiceAddRq>
  </QBXMLMsgsRq>
</QBXML>`;

  return qbxmlEnvelope(body, qbxmlVer);
}

module.exports = { buildInvoiceXML };
