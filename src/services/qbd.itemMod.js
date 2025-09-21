'use strict';

const { escapeXml, qbxmlEnvelope } = require('./qbd.xmlUtils');

function tagIfValue(tag, value) {
  if (value == null) return '';
  const val = typeof value === 'number' ? String(value) : String(value).trim();
  if (!val) return '';
  return `<${tag}>${escapeXml(val)}</${tag}>`;
}

function renderNested(tag, value) {
  if (!value || typeof value !== 'object') return '';
  const inner = Object.entries(value)
    .map(([childTag, childValue]) => tagIfValue(childTag, childValue))
    .filter(Boolean)
    .join('');
  if (!inner) return '';
  return `<${tag}>${inner}</${tag}>`;
}

function renderField(key, value, allFields) {
  if (key === 'BarCodeValue') {
    const barCodeValue = tagIfValue('BarCodeValue', value);
    if (!barCodeValue) return '';
    const allowOverride = tagIfValue('AllowOverride', allFields.BarCodeAllowOverride);
    const assignEvenIfUsed = tagIfValue('AssignEvenIfUsed', allFields.BarCodeAssignEvenIfUsed);
    return `<BarCode>${allowOverride}${assignEvenIfUsed}${barCodeValue}</BarCode>`;
  }

  if (key === 'BarCodeAllowOverride' || key === 'BarCodeAssignEvenIfUsed') {
    return '';
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return renderNested(key, value);
  }

  return tagIfValue(key, value);
}

function buildItemInventoryModXML({ ListID, EditSequence, fields = {} }, qbxmlVer = process.env.QBXML_VER || '16.0') {
  const listId = ListID || (fields && fields.ListID);
  const editSeq = EditSequence || (fields && fields.EditSequence);
  if (!listId || !editSeq) return '';

  const payloadFields = { ...fields };
  delete payloadFields.ListID;
  delete payloadFields.EditSequence;

  const lines = Object.entries(payloadFields)
    .map(([key, value]) => renderField(key, value, payloadFields))
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
