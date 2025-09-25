'use strict';

function toFieldList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function getSkuFieldsPriority() {
  const env = process.env.QBD_SKU_FIELDS || process.env.QBD_SKU_FIELD || 'Name';
  const fields = toFieldList(env);
  return fields.length > 0 ? fields : ['Name'];
}

function pickSku(item, fields = getSkuFieldsPriority()) {
  if (!item || typeof item !== 'object') return null;
  for (const field of fields) {
    const value = item?.[field];
    if (value == null) continue;
    const trimmed = String(value).trim();
    if (trimmed) return trimmed;
  }
  return null;
}

module.exports = { getSkuFieldsPriority, pickSku };
