'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildDiscountLine } = require('../src/services/shopify.discountLine');
const { buildInvoiceXML } = require('../src/services/qbd.invoice');

test('sin descuento devuelve null', () => {
  assert.strictEqual(buildDiscountLine({ total_discounts: '0.00' }), null);
  assert.strictEqual(buildDiscountLine({}), null);
});

test('descuento -> línea Amount negativo con ítem "Discount"', () => {
  const line = buildDiscountLine({
    total_discounts: '4.50',
    discount_codes: [{ code: 'PROMO5' }],
    line_items: [{ taxable: true }],
  });
  assert.strictEqual(line.Amount, -4.5);
  assert.strictEqual(line.ItemRef.FullName, 'Discount');
  assert.strictEqual(line.Desc, 'PROMO5');
  assert.strictEqual(line.SalesTaxCodeRef.FullName, 'TAX');
});

test('descuento automático usa el title y NON si nada es gravable', () => {
  const line = buildDiscountLine({
    total_discounts: '0.45',
    discount_applications: [{ title: 'ALL STORE WHITOUT D4S' }],
    line_items: [{ taxable: false }],
  });
  assert.strictEqual(line.Amount, -0.45);
  assert.strictEqual(line.Desc, 'ALL STORE WHITOUT D4S');
  assert.strictEqual(line.SalesTaxCodeRef.FullName, 'NON');
});

test('env QBD_SHOPIFY_DISCOUNT_ITEM sobreescribe el ítem', () => {
  process.env.QBD_SHOPIFY_DISCOUNT_ITEM = 'SHOPIFY DISCOUNT';
  try {
    const line = buildDiscountLine({ total_discounts: '1.00', line_items: [] });
    assert.strictEqual(line.ItemRef.FullName, 'SHOPIFY DISCOUNT');
  } finally {
    delete process.env.QBD_SHOPIFY_DISCOUNT_ITEM;
  }
});

test('el QBXML de la factura incluye la línea de descuento negativa', () => {
  const discountLine = buildDiscountLine({
    total_discounts: '4.50',
    line_items: [{ taxable: true }],
  });
  const xml = buildInvoiceXML({
    customer: { FullName: 'ONLINE SALES' },
    txnDate: '2026-06-12',
    memo: '1402',
    lines: [
      { ItemRef: { FullName: 'QPOD65 QUAD' }, Quantity: 1, Rate: 90 },
      discountLine,
      { ItemRef: { FullName: 'SHIPPING WITH GUARANTEE' }, Quantity: 1, Rate: 1 },
    ],
  });
  assert.match(xml, /<FullName>Discount<\/FullName>/);
  assert.match(xml, /<Amount>-4\.50<\/Amount>/);
  // el descuento va antes del envío
  assert.ok(xml.indexOf('-4.50') < xml.indexOf('SHIPPING WITH GUARANTEE'));
});
