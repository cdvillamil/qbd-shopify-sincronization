'use strict';
function buildMinimalInventoryQuery(maxReturned = 1) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<?qbxml version="13.0"?>',
    '<QBXML>',
    '  <QBXMLMsgsRq onError="stopOnError">',
    `    <ItemInventoryQueryRq requestID="1">`,
    `      <MaxReturned>${maxReturned}</MaxReturned>`,
    '    </ItemInventoryQueryRq>',
    '  </QBXMLMsgsRq>',
    '</QBXML>'
  ].join('');
}
module.exports = { buildMinimalInventoryQuery };
