'use strict';

const { escapeXml, qbxmlEnvelope, itemRefXml, refXml, addressXml, formatMoney } = require('./qbd.xmlUtils');

function optionalTag(tag, value) {
  if (value == null) return '';
  const val = typeof value === 'number' ? String(value) : String(value).trim();
  if (!val) return '';
  return `<${tag}>${escapeXml(val)}</${tag}>`;
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
  return parts.length ? `<SalesReceiptLineAdd>${parts.join('')}</SalesReceiptLineAdd>` : '';
}

function buildSalesReceiptXML(payload = {}, qbxmlVer = process.env.QBXML_VER || '16.0') {
  const lines = Array.isArray(payload.lines) ? payload.lines.map(lineXml).filter(Boolean) : [];
  if (!lines.length) return '';

  const body = `
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <SalesReceiptAddRq requestID="sales-receipt-1">
      <SalesReceiptAdd>
        ${refXml('CustomerRef', payload.customer)}
        ${optionalTag('ClassRef', payload.ClassRef)}
        ${optionalTag('TxnDate', payload.txnDate || payload.TxnDate)}
        ${optionalTag('RefNumber', payload.refNumber || payload.RefNumber)}
        ${optionalTag('Memo', payload.memo || payload.Memo)}
        ${refXml('PaymentMethodRef', payload.paymentMethod || payload.PaymentMethodRef)}
        ${refXml('DepositToAccountRef', payload.depositToAccount || payload.DepositToAccountRef)}
        ${addressXml('BillAddress', payload.billAddress)}
        ${addressXml('ShipAddress', payload.shipAddress)}
        ${lines.join('')}
      </SalesReceiptAdd>
    </SalesReceiptAddRq>
  </QBXMLMsgsRq>
</QBXML>`;

  return qbxmlEnvelope(body, qbxmlVer);
}

module.exports = { buildSalesReceiptXML };
