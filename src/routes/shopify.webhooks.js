// src/routes/shopify.webhooks.js
'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getInventoryItemSku } = require('../services/shopify.client');
const { resolveSkuToItem } = require('../services/sku-map');
const { enqueueJob, LOG_DIR } = require('../services/jobQueue');

const router = express.Router();

// === snapshot de QBD para conocer QOH (QuantityOnHand)
const INV_PATH = path.join(LOG_DIR, 'last-inventory.json');
function loadInventory() {
  try {
    if (!fs.existsSync(INV_PATH)) return { items: [], allItems: [] };
    const data = JSON.parse(fs.readFileSync(INV_PATH, 'utf8')) || {};
    const items = Array.isArray(data.items) ? data.items : [];
    const allItems = Array.isArray(data.allItems) ? data.allItems : items;
    return { ...data, items, allItems };
  } catch (e) {
    console.warn('[shopify.webhooks] snapshot read error:', e.message || e);
    return { items: [], allItems: [] };
  }
}
function skuFields() {
  const env = process.env.QBD_SKU_FIELDS || process.env.QBD_SKU_FIELD || 'Name';
  return env.split(',').map((s) => s.trim()).filter(Boolean);
}

// --- Helpers ---
function verifyHmac(secret, rawBody, hmacHeader) {
  if (!secret) return true; // si no hay secreto, no bloquear en dev
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(hmacHeader || '', 'utf8'));
}

const rawJson = express.raw({ type: 'application/json' });

function parseMoney(value) {
  if (value == null) return null;
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

function toNumber(value) {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toItemRef(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.ListID) return { ListID: item.ListID };
  if (item.FullName) return { FullName: item.FullName };
  if (item.Name) return { FullName: item.Name };
  return null;
}

function envRef(base, fallbackFullName) {
  const listId = process.env[`${base}_LISTID`];
  const fullName = process.env[`${base}_FULLNAME`] || process.env[base] || fallbackFullName;
  if (listId) return { ListID: listId };
  if (fullName) return { FullName: fullName };
  return null;
}

const invalidXmlCharRegex = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g;

function sanitizeXmlField(value, { orderNumber, field, addressType }) {
  if (value == null) return null;
  const str = String(value);
  const sanitized = str.replace(invalidXmlCharRegex, '');
  if (sanitized !== str) {
    const removedChars = str.match(invalidXmlCharRegex) || [];
    console.warn(
      `[shopify.webhooks] removed invalid XML characters from ${addressType || 'address'} ${
        field || ''
      } (order ${orderNumber || 'unknown'}):`,
      removedChars.map((c) => `0x${c.codePointAt(0).toString(16)}`),
      'original:',
      str
    );
  }
  const trimmed = sanitized.trim();
  return trimmed || null;
}

function mapAddress(addr, { orderNumber, addressType } = {}) {
  if (!addr || typeof addr !== 'object') return null;
  const lines = [];
  const name = sanitizeXmlField([addr.first_name, addr.last_name].filter(Boolean).join(' '), {
    orderNumber,
    field: 'Name',
    addressType,
  });
  if (name) lines.push(name);

  const company = sanitizeXmlField(addr.company, { orderNumber, field: 'Company', addressType });
  if (company) lines.push(company);

  const address1 = sanitizeXmlField(addr.address1, { orderNumber, field: 'Address1', addressType });
  if (address1) lines.push(address1);

  const address2 = sanitizeXmlField(addr.address2, { orderNumber, field: 'Address2', addressType });
  if (address2) lines.push(address2);

  const phone = sanitizeXmlField(addr.phone, { orderNumber, field: 'Phone', addressType });
  if (phone) lines.push(phone);

  const result = {};
  lines.slice(0, 5).forEach((line, idx) => {
    const sanitizedLine = sanitizeXmlField(line, {
      orderNumber,
      field: `Addr${idx + 1}`,
      addressType,
    });
    if (sanitizedLine) {
      result[`Addr${idx + 1}`] = sanitizedLine;
    }
  });

  const city = sanitizeXmlField(addr.city, { orderNumber, field: 'City', addressType });
  if (city) result.City = city;

  const state = sanitizeXmlField(addr.province_code || addr.province, {
    orderNumber,
    field: 'State',
    addressType,
  });
  if (state) result.State = state;

  const postalCode = sanitizeXmlField(addr.zip, { orderNumber, field: 'PostalCode', addressType });
  if (postalCode) result.PostalCode = postalCode;

  const country = sanitizeXmlField(addr.country_code || addr.country, {
    orderNumber,
    field: 'Country',
    addressType,
  });
  if (country) result.Country = country;

  return Object.keys(result).length ? result : null;
}

function toQBDate(value) {
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.valueOf())) return null;
  return dt.toISOString().slice(0, 10);
}

function sanitizeRefNumber(value) {
  if (value == null) return null;
  const str = String(value).trim();
  if (!str) return null;
  const cleaned = str.replace(/[^0-9A-Za-z-]/g, '');
  return cleaned.slice(0, 11) || null;
}

function buildRefNumber(primary, fallbackPrefix, fallbackValue) {
  const primaryRef = sanitizeRefNumber(primary);
  if (primaryRef) return primaryRef;
  const fallbackRef = sanitizeRefNumber(fallbackValue);
  if (fallbackRef) return fallbackRef;
  const fallback = `${fallbackPrefix || 'SR'}${Date.now()}`;
  return sanitizeRefNumber(fallback) || fallback.slice(-11);
}

function onlineSalesCustomerRef() {
  return envRef('QBD_SHOPIFY_CUSTOMER', 'ONLINE SALES') || { FullName: 'ONLINE SALES' };
}

function buildShippingLines(order) {
  const ref = envRef('QBD_SHOPIFY_SHIPPING_ITEM');
  if (!ref) return [];
  const lines = Array.isArray(order?.shipping_lines) ? order.shipping_lines : [];
  const out = [];
  for (const ship of lines) {
    const amount = parseMoney(ship?.price ?? ship?.price_set?.shop_money?.amount);
    if (!amount || amount <= 0) continue;
    out.push({
      ItemRef: { ...ref },
      Desc: ship?.title || 'Shipping',
      Quantity: 1,
      Rate: amount,
    });
  }
  return out;
}

function buildDiscountLine(order) {
  const discount = parseMoney(order?.total_discounts);
  if (!discount || discount <= 0) return null;
  const ref = envRef('QBD_SHOPIFY_DISCOUNT_ITEM');
  if (!ref) return null;
  return {
    ItemRef: { ...ref },
    Desc: 'Shopify discount',
    Quantity: 1,
    Rate: -discount,
  };
}

function collectOrderLines(order, inventoryItems, fieldsPriority) {
  const linesIn = Array.isArray(order?.line_items) ? order.line_items : [];
  const matched = [];
  const notFound = [];

  for (const li of linesIn) {
    const sku = String(li?.sku || '').trim();
    const qty = Math.abs(Number(li?.quantity || 0));
    if (!sku || !qty) continue;

    const item = resolveSkuToItem(inventoryItems || [], sku, fieldsPriority);
    if (!item || (!item.ListID && !item.FullName && !item.Name)) {
      notFound.push(sku);
      continue;
    }

    const ref = toItemRef(item);
    if (!ref) {
      notFound.push(sku);
      continue;
    }

    const rate = parseMoney(
      li?.price ?? li?.price_set?.shop_money?.amount ?? li?.base_price ?? li?.original_price
    );

    const desc = li?.name || li?.title || sku;
    const line = {
      ItemRef: ref,
      Desc: desc,
      Quantity: qty,
    };
    if (rate != null) line.Rate = rate;
    matched.push(line);
  }

  return { matched, notFound };
}

function collectRefundLines(refund, inventoryItems, fieldsPriority) {
  const refundItems = Array.isArray(refund?.refund_line_items) ? refund.refund_line_items : [];
  const matched = [];
  const notFound = [];

  for (const rli of refundItems) {
    const li = rli?.line_item || {};
    const sku = String(li?.sku || '').trim();
    const qty = Math.abs(Number(rli?.quantity || li?.quantity || 0));
    if (!sku || !qty) continue;

    const restockType = String(rli?.restock_type || '').toLowerCase();
    if (restockType === 'no_restock') {
      // No ajustar inventario en QuickBooks para este refund
      continue;
    }

    const item = resolveSkuToItem(inventoryItems || [], sku, fieldsPriority);
    if (!item || (!item.ListID && !item.FullName && !item.Name)) {
      notFound.push(sku);
      continue;
    }

    const ref = toItemRef(item);
    if (!ref) {
      notFound.push(sku);
      continue;
    }

    const rate = parseMoney(
      li?.price ?? rli?.subtotal ?? rli?.subtotal_set?.shop_money?.amount
    );

    const desc = li?.name || li?.title || sku;
    const line = {
      ItemRef: ref,
      Desc: desc,
      Quantity: qty,
    };
    if (rate != null) line.Rate = rate;
    matched.push(line);
  }

  return { matched, notFound };
}

// ============================
//  A) pedidos pagados (venta)
// ============================
// topic: orders/paid   (también puedes apuntar orders/create si prefieres)
router.post('/webhooks/orders/paid', rawJson, async (req, res) => {
  try {
    // 1) Verifica HMAC (opcional pero recomendado)
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    if (!verifyHmac(secret, req.body, hmacHeader)) {
      console.warn('orders/paid: invalid HMAC');
      return res.status(401).send('Invalid HMAC');
    }

    // 2) Parsear el Buffer crudo a JSON
    const order = JSON.parse(req.body.toString('utf8'));

    // 3) Identificadores y fecha
    const orderNumberRaw = order?.order_number ?? order?.name ?? order?.id;
    const orderNumber = orderNumberRaw != null ? String(orderNumberRaw) : '';
    const txnDateISO = order?.processed_at || order?.created_at || new Date().toISOString();
    const txnDate = toQBDate ? toQBDate(txnDateISO) : txnDateISO.slice(0, 10); // YYYY-MM-DD

    // 4) Líneas de producto con Rate = precio unitario de Shopify (sin impuestos)
    const productLines = (order?.line_items || []).map(li => ({
      ItemRef: { FullName: li?.sku || li?.title || 'UNKNOWN-SKU' }, // ajusta si mapeas a ListID
      Desc: li?.title || li?.sku || '',
      Quantity: Number(li?.quantity || 0),
      Rate: Number(li?.price ?? li?.price_set?.shop_money?.amount ?? 0),
      SalesTaxCodeRef: { FullName: li?.taxable ? 'TAX' : 'NON' },
    })).filter(l => l.Quantity > 0);

    
    const SHIPPING_ITEM_NAME = 'SHIPPING WITH GUARANTEE';
    const SHIPPING_DESC = 'CHARGE TO BE APPLIED TO ANY SHIP ITEM';
    const SHIPPING_TAX_CODE = 'TAX'; // usa 'NON' si el envío no es gravable

    // 1) ¿Hubo método de envío?
    const hasShippingMethod = Array.isArray(order?.shipping_lines) && order.shipping_lines.length > 0;

    // 2) Total de envío (robusto: toma price o discounted_price)
    let shippingTotal = 0;
    if (hasShippingMethod) {
      shippingTotal = order.shipping_lines.reduce((sum, s) => {
        const val =
          s?.discounted_price ??
          s?.price ??
          s?.discounted_price_set?.shop_money?.amount ??
          s?.price_set?.shop_money?.amount ??
          0;
        return sum + Number(val);
      }, 0);
    }

    // 3) SIEMPRE agrega la línea si hubo método de envío, aun si es FREE (0.00)
    const shippingLine = hasShippingMethod
      ? [{
          ItemRef: { FullName: SHIPPING_ITEM_NAME },
          Desc: SHIPPING_DESC,
          Quantity: 1,
          Rate: Number.isFinite(shippingTotal) ? Number(shippingTotal) : 0,
          SalesTaxCodeRef: { FullName: SHIPPING_TAX_CODE },
        }]
      : [];

    // 6) Descuento total (opcional, si tu builder lo soporta como DiscountLineAdd)
    const discountAmount = Number(order?.total_discounts || 0);
    const discountPayload = (discountAmount > 0)
      ? { discountAmount, discountDesc: (order?.discount_codes?.map(d => d?.code).join(', ') || 'Discounts') }
      : {};

    // 7) Ensambla líneas finales
    const lines = [
      ...productLines,
      ...shippingLine,
      // si usas ítem de descuento como línea negativa, agrégalo aquí en vez del payload de descuento total
    ];

    // 8) Si no hay líneas, no encolar (evita invoice vacío)
    if (!lines.length) {
      console.warn('orders/paid: no valid lines; skipping invoice enqueue');
      return res.status(200).send('no-lines');
    }

    // 9) Impuesto de compañía (opcional)
    const itemSalesTaxRef = process.env.QBD_COMPANY_TAX_NAME
      ? { FullName: process.env.QBD_COMPANY_TAX_NAME }
      : undefined;

    // 10) Customer/Job fijo para e-commerce
    const customerRef = (typeof onlineSalesCustomerRef === 'function')
      ? onlineSalesCustomerRef()
      : { FullName: 'ONLINE SALES' };

    // 11) Payload del job SIN refNumber (QBD asigna consecutivo); memo = orderNumber
    const jobPayload = {
      customer: customerRef,
      txnDate,
      memo: orderNumber || '', // evita "undefined"
      billAddress: null, // direcciones no se requieren para las facturas
      shipAddress: null, // evita problemas con caracteres no válidos en XML
      itemSalesTaxRef,
      lines,
      ...discountPayload,
    };

    await enqueueJob({
      type: 'invoiceAdd',
      source: 'shopify-order',
      createdAt: new Date().toISOString(),
      payload: jobPayload,
    });

    return res.status(200).send('ok');
  } catch (err) {
    console.error('orders/paid handler error:', err);
    return res.status(200).send('ok');
  }
});


// ===================================================
//  B) inventory_levels/update (ajustes manuales/restock)
// ===================================================
router.post('/webhooks/inventory_levels/update', rawJson, async (req, res) => {
  try {
    const ev = req.body;

    // Derivar delta de forma robusta
    const before = Number(
      ev?.previous_quantity ??
      ev?.inventory_level?.available_before ??
      ev?.available_before
    );
    const after = Number(
      ev?.available ??
      ev?.inventory_level?.available
    );
    let delta = Number.isFinite(after) && Number.isFinite(before)
      ? (after - before)
      : Number(ev?.available_adjustment ?? 0);

    // Si no hay delta discernible, no hacemos nada
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(200).send('noop');
    }

    // VENTAS (delta < 0): se facturan en /orders/paid → NO inventario aquí
    if (delta < 0) {
      return res.status(200).send('ignored-sale-delta');
    }

    // REABASTECIMIENTOS / CORRECCIONES POSITIVAS (delta > 0): encola ajuste si quieres reflejarlo
    // Mapea inventory_item_id → QBD Item (ListID o FullName)
    const listId = (typeof mapToQbdListID === 'function')
      ? mapToQbdListID(ev?.inventory_item_id)
      : null;

    if (!listId) {
      // Si no puedes mapear, registra y evita enviar un ajuste inválido
      console.warn('inventory_levels/update: no mapping for inventory_item_id', ev?.inventory_item_id);
      return res.status(200).send('no-mapping');
    }

    await enqueueJob({
      type: 'inventoryAdjust',
      lines: [
        {
          ListID: listId,
          QuantityDifference: Math.abs(delta),  // delta > 0
        },
      ],
      account: process.env.QBD_ADJUST_ACCOUNT || 'Inventory Adjustment',
      source: 'shopify-inventory-level',
      createdAt: new Date().toISOString(),
    });

    return res.status(200).send('ok');
  } catch (err) {
    console.error('inventory_levels/update handler error:', err);
    return res.status(200).send('ok');
  }
});

// =====================================
//  C) refunds/create -> CreditMemoAdd
// =====================================
/* router.post('/webhooks/refunds/create', rawJson, (req, res) => {
  try {
    if (!verifyHmac(process.env.SHOPIFY_WEBHOOK_SECRET, req.body, req.get('X-Shopify-Hmac-Sha256')))
      return res.status(401).send('Invalid HMAC');

    const payload = JSON.parse(req.body.toString('utf8'));
    const inventory = loadInventory();
    const fieldsPriority = skuFields();
    const { matched, notFound } = collectRefundLines(payload, inventory.items, fieldsPriority);

    if (!matched.length) {
      return res.status(200).json({ ok: true, queued: false, notFound });
    }

    const customerSource = payload?.order ? payload.order : { ...payload, id: payload?.order_id || payload?.id };
    const jobPayload = {
      customer: buildCustomerRef(customerSource),
      txnDate: toQBDate(payload?.processed_at || payload?.created_at),
      refNumber: buildRefNumber(payload?.id, 'RF', payload?.order_id),
      memo: `Shopify refund ${payload?.id || ''}`.trim(),
      lines: matched,
    };

    enqueueJob({
      type: 'creditMemoAdd',
      source: 'shopify-refund',
      createdAt: new Date().toISOString(),
      payload: jobPayload,
    });

    return res.status(200).json({ ok: true, queued: true, lines: matched.length, notFound });
  } catch (e) {
    console.error('refunds/create webhook error:', e);
    return res.status(500).send('error');
  }
});

// ======================================================
//  D) products/update -> ItemInventoryMod (precio/códigos)
// ======================================================
router.post('/webhooks/products/update', rawJson, (req, res) => {
  try {
    if (!verifyHmac(process.env.SHOPIFY_WEBHOOK_SECRET, req.body, req.get('X-Shopify-Hmac-Sha256')))
      return res.status(401).send('Invalid HMAC');

    const payload = JSON.parse(req.body.toString('utf8'));
    const variants = Array.isArray(payload?.variants) ? payload.variants : [];
    if (!variants.length) return res.status(200).send('ok');

    const inv = loadInventory();
    const fieldsPriority = skuFields();

    const queued = [];
    const skipped = [];

    for (const variant of variants) {
      const sku = String(variant?.sku || '').trim();
      if (!sku) continue;

      const searchItems = Array.isArray(inv.allItems) ? inv.allItems : inv.items || [];
      const item = resolveSkuToItem(searchItems, sku, fieldsPriority);
      if (!item || !item.ListID || !item.EditSequence) {
        skipped.push(sku);
        continue;
      }

      const fields = {};
      const price = parseMoney(variant?.price ?? variant?.price_set?.shop_money?.amount);
      if (price != null) fields.SalesPrice = price;

      const barcode = String(variant?.barcode || '').trim();
      if (barcode) fields.BarCodeValue = barcode;

      const titleParts = [];
      const productTitle = String(payload?.title || '').trim();
      const variantTitle = String(variant?.title || '').trim();
      if (productTitle) titleParts.push(productTitle);
      if (variantTitle && variantTitle.toLowerCase() !== 'default title') titleParts.push(variantTitle);
      const desc = titleParts.join(' - ') || String(variant?.name || '').trim();
      if (desc) fields.SalesDesc = desc.slice(0, 4095);

      if (!Object.keys(fields).length) {
        skipped.push(sku);
        continue;
      }

      enqueueJob({
        type: 'itemInventoryMod',
        source: 'shopify-product',
        createdAt: new Date().toISOString(),
        payload: {
          ListID: item.ListID,
          EditSequence: item.EditSequence,
          fields,
        },
      });

      queued.push({ sku, fields: Object.keys(fields) });
    }

    return res.status(200).json({ ok: true, queued: queued.length, details: queued, skipped });
  } catch (e) {
    console.error('products/update webhook error:', e);
    return res.status(500).send('error');
  }
}); */

module.exports = router;
