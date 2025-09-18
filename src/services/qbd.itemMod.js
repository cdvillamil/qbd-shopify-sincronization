'use strict';

const { escapeXml, qbxmlEnvelope } = require('./qbd.xmlUtils');

function tagIfValue(tag, value) {
  if (value == null) return '';
  const val = typeof value === 'number' ? String(value) : String(value).trim();
  if (!val) return '';
  return `<${tag}>${escapeXml(val)}</${tag}>`;
}

function buildItemInventoryModXML({ ListID, EditSequence, fields = {} }, qbxmlVer = process.env.QBXML_VER || '16.0') {
  const listId = ListID || (fields && fields.ListID);
  const editSeq = EditSequence || (fields && fields.EditSequence);
  if (!listId || !editSeq) return '';

  const payloadFields = { ...fields };
  delete payloadFields.ListID;
  delete payloadFields.EditSequence;

  const lines = Object.entries(payloadFields)
    .map(([key, value]) => tagIfValue(key, value))
    .filter(Boolean)
    .join('');

  if (!lines) return '';

  const body = `
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <ItemInventoryModRq requestID="item-mod-1">
      <ItemInventoryMod>
        <ListID>${escapeXml(listId)}</ListID>
        <EditSequence>${escapeXml(editSeq)}</EditSequence>
        ${lines}
      </ItemInventoryMod>
    </ItemInventoryModRq>
  </QBXMLMsgsRq>
</QBXML>`;

  return qbxmlEnvelope(body, qbxmlVer);
}

module.exports = { buildItemInventoryModXML };
