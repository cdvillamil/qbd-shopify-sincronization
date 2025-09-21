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

function mapAddress(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const lines = [];
  const name = [addr.first_name, addr.last_name].filter(Boolean).join(' ').trim();
  if (name) lines.push(name);
  if (addr.company) lines.push(addr.company);
  if (addr.address1) lines.push(addr.address1);
  if (addr.address2) lines.push(addr.address2);
  if (addr.phone) lines.push(addr.phone);
  const result = {};
  lines.slice(0, 5).forEach((line, idx) => {
    result[`Addr${idx + 1}`] = line;
  });
  if (addr.city) result.City = addr.city;
  if (addr.province_code || addr.province) result.State = addr.province_code || addr.province;
  if (addr.zip) result.PostalCode = addr.zip;
  if (addr.country_code || addr.country) result.Country = addr.country_code || addr.country;
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

function buildCustomerRef(order) {
  const envCustomer = envRef('QBD_SHOPIFY_CUSTOMER');
  if (envCustomer) return envCustomer;

  const parts = [];
  if (order?.customer) {
    if (order.customer.first_name) parts.push(order.customer.first_name);
    if (order.customer.last_name) parts.push(order.customer.last_name);
  }
  if (!parts.length && order?.billing_address) {
    if (order.billing_address.first_name) parts.push(order.billing_address.first_name);
    if (order.billing_address.last_name) parts.push(order.billing_address.last_name);
  }
  if (!parts.length && order?.shipping_address) {
    if (order.shipping_address.first_name) parts.push(order.shipping_address.first_name);
    if (order.shipping_address.last_name) parts.push(order.shipping_address.last_name);
  }
  if (!parts.length && order?.email) parts.push(order.email);

  let name = parts.join(' ').replace(/\s+/g, ' ').trim();
  if (!name) name = `Shopify Customer ${order?.id || ''}`.trim();
  if (!name) name = 'Shopify Customer';
  if (name.length > 41) name = name.slice(0, 41);
  return { FullName: name };
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
router.post('/webhooks/orders/paid', rawJson, (req, res) => {
  try {
    if (!verifyHmac(process.env.SHOPIFY_WEBHOOK_SECRET, req.body, req.get('X-Shopify-Hmac-Sha256')))
      return res.status(401).send('Invalid HMAC');

    const payload = JSON.parse(req.body.toString('utf8'));
    const inventory = loadInventory();
    const fieldsPriority = skuFields();

    const { matched, notFound } = collectOrderLines(payload, inventory.items, fieldsPriority);
    const shippingLines = buildShippingLines(payload);
    const discountLine = buildDiscountLine(payload);

    const allLines = [...matched, ...shippingLines];
    if (discountLine) allLines.push(discountLine);

    if (!allLines.length) {
      return res.status(200).json({ ok: true, queued: false, notFound });
    }

    const customerSource = payload?.order ? payload.order : { ...payload, id: payload?.order_id || payload?.id };
    const jobPayload = {
      customer: buildCustomerRef(customerSource),
      txnDate: toQBDate(payload?.processed_at || payload?.created_at),
      refNumber: buildRefNumber(payload?.order_number ?? payload?.name, 'SO', payload?.id),
      memo: `Shopify order ${payload?.name || payload?.order_number || payload?.id}`,
      billAddress: mapAddress(payload?.billing_address),
      shipAddress: mapAddress(payload?.shipping_address),
      lines: allLines,
    };

    const paymentMethodRef = envRef('QBD_SHOPIFY_PAYMENT_METHOD');
    if (paymentMethodRef) jobPayload.paymentMethod = paymentMethodRef;

    const depositAccountRef = envRef('QBD_SHOPIFY_DEPOSIT_ACCOUNT');
    if (depositAccountRef) jobPayload.depositToAccount = depositAccountRef;

    enqueueJob({
      type: 'salesReceiptAdd',
      source: 'shopify-order',
      createdAt: new Date().toISOString(),
      payload: jobPayload,
    });

    return res.status(200).json({ ok: true, queued: true, lines: allLines.length, notFound });
  } catch (e) {
    console.error('orders/paid webhook error:', e);
    return res.status(500).send('error');
  }
});

// ===================================================
//  B) inventory_levels/update (ajustes manuales/restock)
// ===================================================
router.post('/webhooks/inventory_levels/update', rawJson, async (req, res) => {
  try {
    if (!verifyHmac(process.env.SHOPIFY_WEBHOOK_SECRET, req.body, req.get('X-Shopify-Hmac-Sha256')))
      return res.status(401).send('Invalid HMAC');
    console.log('[WEBHOOK] HIT inventory_levels/update', {
      ts,
      len: req.body?.length,
      topic: req.get('X-Shopify-Topic'),
      shop: req.get('X-Shopify-Shop-Domain'),
      ver: req.get('X-Shopify-Api-Version'),
      ctype: req.get('Content-Type'),
    });
    const payload = JSON.parse(req.body.toString('utf8'));
    const inventoryLevel =
      payload && typeof payload.inventory_level === 'object' ? payload.inventory_level : null;
    const invItemId = payload?.inventory_item_id ?? inventoryLevel?.inventory_item_id;
    const resolvedAvailable =
      toNumber(payload?.available) ?? toNumber(inventoryLevel?.available);
    const resolvedAdjustment =
      toNumber(payload?.available_adjustment) ?? toNumber(inventoryLevel?.available_adjustment);

    if (!invItemId) return res.status(200).send('ok');
    if (resolvedAvailable == null && resolvedAdjustment == null) return res.status(200).send('ok');

    // 1) obtener SKU desde inventory_item_id
    const sku = await getInventoryItemSku(invItemId).catch(() => null);
    if (!sku) return res.status(200).send('ok');

    // 2) buscar item QBD por SKU (prioridades + overrides)
    const inv = loadInventory();
    const fieldsPriority = skuFields();
    const searchItems = Array.isArray(inv.allItems) ? inv.allItems : inv.items || [];
    const it = resolveSkuToItem(searchItems, sku, fieldsPriority);
    if (!it) return res.status(200).send('ok');

    // 3) calcular delta con respecto a QBD (snapshot)
    const qbdQohRaw = toNumber(it.QuantityOnHand);
    const qbdQoh = qbdQohRaw == null ? 0 : qbdQohRaw;
    let newAvailable = resolvedAvailable;
    if (newAvailable == null && resolvedAdjustment != null) newAvailable = qbdQoh + resolvedAdjustment;
    const delta =
      resolvedAdjustment != null
        ? resolvedAdjustment
        : newAvailable != null
        ? newAvailable - qbdQoh
        : 0;

    const itemRef = toItemRef(it);
    if (!itemRef) {
      return res.status(200).json({
        ok: true,
        sku,
        qbdQoh,
        available: newAvailable,
        availableAdjustment: resolvedAdjustment,
        delta,
        queued: false,
      });
    }

    if (!delta) {
      return res.status(200).json({
        ok: true,
        sku,
        qbdQoh,
        available: newAvailable,
        availableAdjustment: resolvedAdjustment,
        delta,
        queued: false,
      });
    }
    console.log('[WEBHOOK] payload parsed', { invItemId, sku, qbdQoh, newAvailable, resolvedAdjustment, delta });
    enqueueJob({
      type: 'inventoryAdjust',
      lines: [{ ...itemRef, QuantityDifference: delta }],
      account: process.env.QBD_ADJUST_ACCOUNT || undefined,
      source: 'shopify-inventory-level',
      createdAt: new Date().toISOString(),
    });

    return res.status(200).json({
      ok: true,
      sku,
      qbdQoh,
      available: newAvailable,
      availableAdjustment: resolvedAdjustment,
      delta,
      queued: true,
    });
  } catch (e) {
    console.error('inventory_levels/update webhook error:', e);
    return res.status(500).send('error');
  }
});

// =====================================
//  C) refunds/create -> CreditMemoAdd
// =====================================
router.post('/webhooks/refunds/create', rawJson, (req, res) => {
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
});

module.exports = router;
