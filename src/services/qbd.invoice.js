'use strict';

const { escapeXml, qbxmlEnvelope, itemRefXml, refXml, addressXml, formatMoney } = require('./qbd.xmlUtils');

function optionalTag(tag, value) {
  if (value == null) return '';
  const val = typeof value === 'number' ? String(value) : String(value).trim();
  if (!val) return '';
  return `<${tag}>${escapeXml(val)}</${tag}>`;
}

function optionalDate(tag, value) {
  if (!value) return '';
  const dt = new Date(value);
  if (Number.isNaN(dt.valueOf())) return '';
  return `<${tag}>${escapeXml(dt.toISOString().slice(0, 10))}</${tag}>`;
}

function lineXml(line = {}) {
  if (!line) return '';

  const parts = [];
  const itemXml = itemRefXml(line.ItemRef || line.itemRef || line.item || {});
  if (itemXml) parts.push(itemXml);

  const desc = line.Desc || line.desc;
  if (desc) parts.push(`<Desc>${escapeXml(desc)}</Desc>`);

  const quantity =
    line.Quantity != null
      ? line.Quantity
      : line.quantity != null
      ? line.quantity
      : null;
  if (quantity != null) parts.push(`<Quantity>${escapeXml(quantity)}</Quantity>`);

  const rate = line.Rate != null ? line.Rate : line.rate;
  const amount = line.Amount != null ? line.Amount : line.amount;
  const rateStr = rate != null ? formatMoney(rate) : null;
  const amountStr = amount != null ? formatMoney(amount) : null;
  if (rateStr != null) parts.push(`<Rate>${rateStr}</Rate>`);
  if (amountStr != null && rateStr == null) parts.push(`<Amount>${amountStr}</Amount>`);

  if (line.ServiceDate || line.serviceDate) {
    const xml = optionalDate('ServiceDate', line.ServiceDate || line.serviceDate);
    if (xml) parts.push(xml);
  }

  const classRef = line.ClassRef || line.classRef;
  if (classRef) parts.push(refXml('ClassRef', classRef));

  const salesTaxCodeRef = line.SalesTaxCodeRef || line.salesTaxCode || line.salesTaxCodeRef;
  if (salesTaxCodeRef) parts.push(refXml('SalesTaxCodeRef', salesTaxCodeRef));

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
        ${refXml('ClassRef', payload.classRef || payload.ClassRef)}
        ${refXml('ARAccountRef', payload.arAccount || payload.ARAccountRef)}
        ${refXml('TemplateRef', payload.template || payload.TemplateRef)}
        ${optionalDate('TxnDate', payload.txnDate || payload.TxnDate)}
        ${optionalTag('RefNumber', payload.refNumber || payload.RefNumber)}
        ${refXml('TermsRef', payload.terms || payload.TermsRef)}
        ${optionalDate('DueDate', payload.dueDate || payload.DueDate)}
        ${optionalTag('PONumber', payload.poNumber || payload.PONumber)}
        ${optionalTag('Memo', payload.memo || payload.Memo)}
        ${addressXml('BillAddress', payload.billAddress || payload.BillAddress)}
        ${addressXml('ShipAddress', payload.shipAddress || payload.ShipAddress)}
        ${refXml('SalesRepRef', payload.salesRep || payload.SalesRepRef)}
        ${refXml('ShipMethodRef', payload.shipMethod || payload.ShipMethodRef)}
        ${optionalTag('FOB', payload.fob || payload.FOB)}
        ${lines.join('')}
      </InvoiceAdd>
    </InvoiceAddRq>
  </QBXMLMsgsRq>
</QBXML>`;

  return qbxmlEnvelope(body, qbxmlVer);
}

module.exports = { buildInvoiceXML };
