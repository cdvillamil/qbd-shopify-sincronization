'use strict';

const { escapeXml, qbxmlEnvelope } = require('./qbd.xmlUtils');

const BARCODE_FIELD_KEYS = new Set(['BarCodeValue', 'BarCodeAllowOverride', 'BarCodeAssignEvenIfUsed']);

const FIELD_SEQUENCE = [
  'Name',
  'IsActive',
  'ParentRef',
  'ClassRef',
  'ManufacturerPartNumber',
  'UnitOfMeasureSetRef',
  'IsTaxIncluded',
  'SalesTaxCodeRef',
  'BarCode',
  'SalesDesc',
  'SalesPrice',
  'IncomeAccountRef',
  'ApplyIncomeAccountRefToExistingTxns',
  'PurchaseDesc',
  'PurchaseCost',
  'PurchaseTaxCodeRef',
  'COGSAccountRef',
  'PrefVendorRef',
  'AssetAccountRef',
  'ReorderPoint',
  'Max',
  'QuantityOnHand',
  'InventorySiteRef',
  'InventorySiteLocationRef',
  'QuantityOnOrder',
  'QuantityOnSalesOrder',
  'ExternalGUID',
];

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

function renderField(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return renderNested(key, value);
  }

  return tagIfValue(key, value);
}

function renderBarCodeAggregate(fields) {
  const barCodeValue = tagIfValue('BarCodeValue', fields.BarCodeValue);
  if (!barCodeValue) return '';

  const allowOverride = tagIfValue('AllowOverride', fields.BarCodeAllowOverride);
  const assignEvenIfUsed = tagIfValue('AssignEvenIfUsed', fields.BarCodeAssignEvenIfUsed);
  return `<BarCode>${allowOverride}${assignEvenIfUsed}${barCodeValue}</BarCode>`;
}

function buildItemInventoryModXML({ ListID, EditSequence, fields = {} }, qbxmlVer = process.env.QBXML_VER || '16.0') {
  const listId = ListID || (fields && fields.ListID);
  const editSeq = EditSequence || (fields && fields.EditSequence);
  if (!listId || !editSeq) return '';

  const payloadFields = { ...fields };
  delete payloadFields.ListID;
  delete payloadFields.EditSequence;

  const segments = [];
  const processed = new Set();

  for (const key of FIELD_SEQUENCE) {
    if (key === 'BarCode') {
      const aggregate = renderBarCodeAggregate(payloadFields);
      if (aggregate) segments.push(aggregate);
      processed.add('BarCode');
      BARCODE_FIELD_KEYS.forEach((barcodeKey) => processed.add(barcodeKey));
      continue;
    }

    if (processed.has(key)) continue;
    if (!(key in payloadFields)) continue;

    const rendered = renderField(key, payloadFields[key]);
    if (rendered) segments.push(rendered);
    processed.add(key);
  }

  for (const [key, value] of Object.entries(payloadFields)) {
    if (processed.has(key)) continue;

    const rendered = renderField(key, value);
    if (rendered) segments.push(rendered);
    processed.add(key);
  }

  const lines = segments.join('');

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
