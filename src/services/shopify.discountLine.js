'use strict';

// Construye la línea de descuento (Amount negativo) para una factura QBD
// a partir de un pedido de Shopify. Ítem por defecto: "Discount"
// (configurable con QBD_SHOPIFY_DISCOUNT_ITEM / _FULLNAME / _LISTID).

function parseMoney(value) {
  if (value == null) return null;
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

function discountItemRef() {
  const listId = process.env.QBD_SHOPIFY_DISCOUNT_ITEM_LISTID;
  const fullName =
    process.env.QBD_SHOPIFY_DISCOUNT_ITEM_FULLNAME ||
    process.env.QBD_SHOPIFY_DISCOUNT_ITEM;
  if (listId) return { ListID: listId };
  if (fullName) return { FullName: fullName };
  return { FullName: 'Discount' };
}

function buildDiscountLine(order) {
  const discount = parseMoney(order && order.total_discounts);
  if (!discount || discount <= 0) return null;

  const codes =
    (Array.isArray(order && order.discount_codes) &&
      order.discount_codes.map((d) => d && d.code).filter(Boolean).join(', ')) || '';
  const titles =
    (Array.isArray(order && order.discount_applications) &&
      order.discount_applications.map((d) => d && d.title).filter(Boolean).join(', ')) || '';
  const anyTaxable =
    Array.isArray(order && order.line_items) &&
    order.line_items.some((li) => li && li.taxable);

  return {
    ItemRef: { ...discountItemRef() },
    Desc: codes || titles || 'Shopify discount',
    Amount: -discount,
    SalesTaxCodeRef: { FullName: anyTaxable ? 'TAX' : 'NON' },
  };
}

module.exports = { buildDiscountLine, parseMoney };
