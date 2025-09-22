'use strict';

function decodeXmlEntities(value) {
  if (typeof value !== 'string' || value.indexOf('&') === -1) return value;
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractAttribute(rawAttributes, attrName) {
  if (!rawAttributes) return undefined;
  const doubleQuoted = new RegExp(`${attrName}\\s*=\\s*"([^"]*)"`, 'i').exec(rawAttributes);
  if (doubleQuoted) return decodeXmlEntities(doubleQuoted[1]);
  const singleQuoted = new RegExp(`${attrName}\\s*=\\s*'([^']*)'`, 'i').exec(rawAttributes);
  if (singleQuoted) return decodeXmlEntities(singleQuoted[1]);
  return undefined;
}

function normalizeStatusCode(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const asNumber = Number(trimmed);
    if (Number.isSafeInteger(asNumber)) return asNumber;
  }
  return trimmed;
}

function extractStatusSummaries(qbxmlText) {
  if (typeof qbxmlText !== 'string' || qbxmlText.trim() === '') return [];

  const statuses = [];
  const regex = /<([A-Za-z0-9]+)Rs\b([^>]*)>/g;
  let match;
  while ((match = regex.exec(qbxmlText)) !== null) {
    const [, responseName, rawAttributes = ''] = match;
    const statusCode = extractAttribute(rawAttributes, 'statusCode');
    const statusSeverity = extractAttribute(rawAttributes, 'statusSeverity');
    const statusMessage = extractAttribute(rawAttributes, 'statusMessage');

    if (statusCode || statusSeverity || statusMessage) {
      const entry = { response: `${responseName}Rs` };
      if (statusCode != null) entry.statusCode = normalizeStatusCode(statusCode);
      if (statusSeverity != null) entry.statusSeverity = statusSeverity;
      if (statusMessage != null) entry.statusMessage = statusMessage;
      statuses.push(entry);
    }
  }

  return statuses;
}

module.exports = {
  extractStatusSummaries,
};
