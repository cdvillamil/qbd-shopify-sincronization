'use strict';

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function qbxmlEnvelope(innerBody, qbxmlVer = process.env.QBXML_VER || '16.0') {
  const ver = String(qbxmlVer || '16.0');
  const header = `<?xml version="1.0" ?><?qbxml version="${ver}"?>\r\n`;
  return header + String(innerBody || '');
}

function itemRefXml(ref) {
  if (!ref || typeof ref !== 'object') return '';
  if (ref.ListID) {
    return `<ItemRef><ListID>${escapeXml(ref.ListID)}</ListID></ItemRef>`;
  }
  if (ref.FullName) {
    return `<ItemRef><FullName>${escapeXml(ref.FullName)}</FullName></ItemRef>`;
  }
  return '';
}

function refXml(tag, ref) {
  if (!ref || typeof ref !== 'object') return '';
  if (ref.ListID) {
    return `<${tag}><ListID>${escapeXml(ref.ListID)}</ListID></${tag}>`;
  }
  if (ref.FullName) {
    return `<${tag}><FullName>${escapeXml(ref.FullName)}</FullName></${tag}>`;
  }
  return '';
}

function addressXml(tagName, address = {}) {
  if (!address) return '';
  const parts = [];
  const lines = [];
  for (let i = 1; i <= 5; i += 1) {
    const key = `Addr${i}`;
    if (address[key]) {
      lines.push(`<${key}>${escapeXml(address[key])}</${key}>`);
    }
  }
  if (address.City) parts.push(`<City>${escapeXml(address.City)}</City>`);
  if (address.State) parts.push(`<State>${escapeXml(address.State)}</State>`);
  if (address.PostalCode) parts.push(`<PostalCode>${escapeXml(address.PostalCode)}</PostalCode>`);
  if (address.Country) parts.push(`<Country>${escapeXml(address.Country)}</Country>`);

  const body = [...lines, ...parts].join('');
  if (!body) return '';
  return `<${tagName}>${body}</${tagName}>`;
}

function formatMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return (Math.round(num * 100) / 100).toFixed(2);
}

module.exports = {
  escapeXml,
  qbxmlEnvelope,
  itemRefXml,
  refXml,
  addressXml,
  formatMoney,
};
