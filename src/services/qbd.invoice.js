'use strict';

const {
  escapeXml,
  qbxmlEnvelope,
  itemRefXml,
  refXml,
  addressXml,
  formatMoney,
} = require('./qbd.xmlUtils');

function optionalTag(tag, value) {
  if (value == null) return '';
  const val = typeof value === 'number' ? String(value) : String(value).trim();
  if (!val) return '';
  return `<${tag}>${escapeXml(val)}</${tag}>`;
}

function resolveRefXml(tag, value) {
  if (!value) return '';
  if (typeof value === 'object') return refXml(tag, value);
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  return `<${tag}><FullName>${escapeXml(trimmed)}</FullName></${tag}>`;
}

function customerRefXml(payload = {}) {
  if (payload.customer) return refXml('CustomerRef', payload.customer);
  const name = payload.customerFullName || payload.customerName || 'ONLINE SALES';
  if (!name) return '';
  return `<CustomerRef><FullName>${escapeXml(name)}</FullName></CustomerRef>`;
}

function itemSalesTaxRefXml(payload = {}) {
  if (payload.itemSalesTaxRef) return refXml('ItemSalesTaxRef', payload.itemSalesTaxRef);
  const fullName = payload.itemSalesTaxName || 'FL TAX 7%';
  if (!fullName) return '';
  return `<ItemSalesTaxRef><FullName>${escapeXml(fullName)}</FullName></ItemSalesTaxRef>`;
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
  return parts.length ? `<InvoiceLineAdd>${parts.join('')}</InvoiceLineAdd>` : '';
}

function buildInvoiceXML(payload = {}, qbxmlVer = process.env.QBXML_VER || '16.0') {
  const lines = Array.isArray(payload.lines) ? payload.lines.map(lineXml).filter(Boolean) : [];
  if (!lines.length) return '';

  const requestIdRaw =
    payload.requestId ||
    payload.RequestID ||
    (payload.shopifyOrderId != null ? `INV-${payload.shopifyOrderId}` : null) ||
    'invoice-1';
  const requestId = escapeXml(requestIdRaw);

  const poNumber =
    payload.poNumber ||
    payload.PONumber ||
    payload.shopifyOrderNumber ||
    payload.shopifyOrderName ||
    null;
  const memo =
    payload.memo ||
    payload.Memo ||
    (payload.shopifyOrderNumber
      ? `Pedido Shopify #${payload.shopifyOrderNumber}`
      : payload.shopifyOrderName
      ? `Pedido Shopify #${payload.shopifyOrderName}`
      : null);

  const billAddress = addressXml('BillAddress', payload.billAddress);
  const shipAddress = addressXml('ShipAddress', payload.shipAddress);
  const customerRef = customerRefXml(payload);
  const itemSalesTaxRef = itemSalesTaxRefXml(payload);

  const invoiceParts = [
    customerRef,
    resolveRefXml('ClassRef', payload.ClassRef),
    resolveRefXml('ARAccountRef', payload.ARAccountRef),
    resolveRefXml('TemplateRef', payload.TemplateRef),
    optionalTag('TxnDate', payload.txnDate || payload.TxnDate),
    optionalTag('RefNumber', payload.refNumber || payload.RefNumber),
    resolveRefXml('TermsRef', payload.TermsRef),
    resolveRefXml('SalesRepRef', payload.SalesRepRef),
    billAddress,
    shipAddress,
    itemSalesTaxRef,
    optionalTag('PONumber', poNumber),
    optionalTag('Memo', memo),
    ...lines,
  ].filter(Boolean);

  const body = `
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <InvoiceAddRq requestID="${requestId}">
      <InvoiceAdd>
        ${invoiceParts.join('\n        ')}
      </InvoiceAdd>
    </InvoiceAddRq>
  </QBXMLMsgsRq>
</QBXML>`;

  return qbxmlEnvelope(body, qbxmlVer);
}

module.exports = { buildInvoiceXML };
