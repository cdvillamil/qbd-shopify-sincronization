'use strict';

const { escapeXml, qbxmlEnvelope, itemRefXml, refXml, formatMoney } = require('./qbd.xmlUtils');

// Devuelve XML de dirección SOLO si tiene al menos Addr1 o City.
// Orden interno ESTRICTO: Addr1..Addr5, City, State, PostalCode, Country
function addressXml(tag, addr) {
  if (!addr || typeof addr !== 'object') return '';
  const A1 = addr.Addr1 ?? addr.addr1;
  const CT = addr.City ?? addr.city;
  const ST = addr.State ?? addr.state;
  const PC = addr.PostalCode ?? addr.postalCode ?? addr.zip;
  const CO = addr.Country ?? addr.country;

  // Si viene SOLO State/Country (como en tu log), mejor NO mandar la dirección
  if ((A1 == null || A1 === '') && (CT == null || CT === '')) return '';

  const A2 = addr.Addr2 ?? addr.addr2;
  const A3 = addr.Addr3 ?? addr.addr3;
  const A4 = addr.Addr4 ?? addr.addr4;
  const A5 = addr.Addr5 ?? addr.addr5;

  const parts = [];
  if (A1) parts.push(`<Addr1>${escapeXml(A1)}</Addr1>`);
  if (A2) parts.push(`<Addr2>${escapeXml(A2)}</Addr2>`);
  if (A3) parts.push(`<Addr3>${escapeXml(A3)}</Addr3>`);
  if (A4) parts.push(`<Addr4>${escapeXml(A4)}</Addr4>`);
  if (A5) parts.push(`<Addr5>${escapeXml(A5)}</Addr5>`);
  if (CT) parts.push(`<City>${escapeXml(CT)}</City>`);
  if (ST) parts.push(`<State>${escapeXml(ST)}</State>`);
  if (PC) parts.push(`<PostalCode>${escapeXml(PC)}</PostalCode>`);
  if (CO) parts.push(`<Country>${escapeXml(CO)}</Country>`);

  return parts.length ? `<${tag}>${parts.join('')}</${tag}>` : '';
}
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
