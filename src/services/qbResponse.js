'use strict';

// Lee los códigos de estado de una respuesta QBXML (InvoiceAddRs,
// SalesReceiptAddRs, CreditMemoAddRs, InventoryAdjustmentAddRs, ItemInventoryQueryRs…).
// El Web Connector puede entregar la respuesta escapada (&lt;…&gt;), así que se
// decodifica antes de buscar.

function unescapeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

/**
 * @returns {{ statuses: Array<{node,code,severity,message}>, errors: Array<{node,code,severity,message}> }}
 * Un estado es error si statusSeverity="Error", o si no trae severidad y el código no es 0.
 */
function analyzeQbResponse(resp) {
  const xml = unescapeXml(resp);
  const statuses = [];
  const re = /<((?:\w+:)?\w+Rs)\b[^>]*\bstatusCode="[^"]*"[^>]*>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const tag = m[0];
    statuses.push({
      node: m[1].replace(/^\w+:/, ''),
      code: attr(tag, 'statusCode'),
      severity: attr(tag, 'statusSeverity'),
      message: attr(tag, 'statusMessage') || '',
    });
  }
  const errors = statuses.filter((s) =>
    s.severity ? /^error$/i.test(s.severity) : (s.code != null && s.code !== '0'));
  return { statuses, errors };
}

module.exports = { analyzeQbResponse, unescapeXml };
