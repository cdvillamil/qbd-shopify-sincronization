// src/routes/shopify.webhooks.js
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getInventoryItemSku, findVariantByInventoryItemId } = require('../services/shopify.client');
const { resolveSkuToItem } = require('../services/sku-map');
const { enqueue, prioritizeJobs } = require('../services/jobQueue');
const { trackPendingAdjustments } = require('../services/pendingAdjustments');
const { resolveInventoryItemSku, rememberInventoryItems } = require('../services/inventoryItemMap');

const router = express.Router();

function prioritizeShopifyAdjustments() {
  prioritizeJobs((job) => {
    if (!job || job.type !== 'inventoryAdjust') return false;
    const source = String(job.source || '').toLowerCase();
    return source.startsWith('shopify-');
  });
}

// === cola (mismo archivo que usa el server) ===
const TMP_DIR = process.env.LOG_DIR || '/tmp';

// === snapshot de QBD para conocer QOH (QuantityOnHand)
const INV_PATH = path.join(TMP_DIR, 'last-inventory.json');
function loadInventory() {
  try {
    const raw = fs.readFileSync(INV_PATH, 'utf8');
    const parsed = JSON.parse(raw) || {};
    const filteredItems = Array.isArray(parsed?.items) ? parsed.items : [];
    let sourceItems = Array.isArray(parsed?.sourceItems) ? parsed.sourceItems : [];

    if (!sourceItems.length && Array.isArray(parsed?.source?.items)) {
      sourceItems = parsed.source.items;
    }

    if (!sourceItems.length) sourceItems = filteredItems;

    return {
      ...parsed,
      items: sourceItems,
      filteredItems,
    };
  } catch {
    return { items: [], filteredItems: [] };
  }
}
function skuFields() {
  const env = process.env.QBD_SKU_FIELDS || process.env.QBD_SKU_FIELD || 'Name';
  return env.split(',').map(s => s.trim()).filter(Boolean);
}

// --- verificación HMAC ---
function verifyHmac(secret, rawBody, hmacHeader) {
  if (!secret) return true; // si no hay secreto, no bloquear en dev
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  return crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(hmacHeader || '', 'utf8'));
}
const rawJson = express.raw({ type: 'application/json' });

// ============================
//  A) pedidos pagados (venta)
// ============================
// topic: orders/paid   (también puedes apuntar orders/create si prefieres)
router.post('/webhooks/orders/paid', rawJson, async (req, res) => {
  try {
    if (!verifyHmac(process.env.SHOPIFY_WEBHOOK_SECRET, req.body, req.get('X-Shopify-Hmac-Sha256')))
      return res.status(401).send('Invalid HMAC');

    const payload = JSON.parse(req.body.toString('utf8'));
    const linesIn = Array.isArray(payload.line_items) ? payload.line_items : [];
    if (!linesIn.length) return res.status(200).send('ok');

    const inv = loadInventory();
    const fieldsPriority = skuFields();

    const aggregated = new Map();
    const notFound = [];

    for (const li of linesIn) {
      const sku = String(li.sku || '').trim();
      const qty = Math.abs(Number(li.quantity || 0));
      if (!sku || !qty) continue;

      const it = resolveSkuToItem(inv.items || [], sku, fieldsPriority);
      if (!it) { notFound.push(sku); continue; }

      const delta = -qty; // venta descuenta
      const key = it.ListID
        ? `id:${it.ListID}`
        : `name:${String(it.FullName || it.Name || sku).trim().toLowerCase()}`;

      if (!aggregated.has(key)) {
        aggregated.set(key, {
          sku,
          delta: 0,
          qbdQoh: Number(it.QuantityOnHand || 0),
          listId: it.ListID || null,
          fullName: it.FullName || it.Name || sku,
        });
      }

      const entry = aggregated.get(key);
      entry.delta += delta;
    }

    const lines = [];
    const adjustments = [];
    for (const entry of aggregated.values()) {
      if (!entry.delta) continue;
      const line = entry.listId
        ? { ListID: entry.listId, QuantityDifference: entry.delta }
        : { FullName: entry.fullName, QuantityDifference: entry.delta };
      lines.push(line);
      adjustments.push({
        sku: entry.sku,
        delta: entry.delta,
        qbdQoh: entry.qbdQoh,
        target: Number.isFinite(entry.qbdQoh) ? entry.qbdQoh + entry.delta : undefined,
        source: 'shopify-order',
        note: payload?.name ? `order ${payload.name}` : undefined,
      });
    }

    let jobId = null;

    if (lines.length) {
      jobId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
      enqueue({
        id: jobId,
        type: 'inventoryAdjust',
        lines,
        account: process.env.QBD_ADJUST_ACCOUNT || undefined,
        source: 'shopify-order',
        createdAt: new Date().toISOString(),
        skus: adjustments.map((a) => a.sku).filter(Boolean),
        pendingAdjustments: adjustments,
      });
      prioritizeShopifyAdjustments();
      trackPendingAdjustments(jobId, adjustments);
    }

    return res.status(200).json({ ok: true, queuedLines: lines.length, notFound, jobId });
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

    const payload = JSON.parse(req.body.toString('utf8'));
    const invItemId = payload?.inventory_item_id;
    const available = Number(payload?.available);

    if (!invItemId || Number.isNaN(available)) return res.status(200).send('ok');

    // 1) obtener SKU desde inventory_item_id
    let sku = resolveInventoryItemSku(invItemId);
    let variantMeta = null;
    const rememberEntries = [];

    if (!sku) {
      variantMeta = await findVariantByInventoryItemId(invItemId).catch(() => null);
      if (variantMeta?.sku) {
        sku = variantMeta.sku;
        rememberEntries.push({
          sku,
          inventory_item_id: invItemId,
          variant_id: variantMeta.id,
          source: 'webhook-variant-lookup',
        });
      }
    }

    if (!sku) {
      const fallbackSku = await getInventoryItemSku(invItemId).catch(() => null);
      if (fallbackSku) {
        sku = fallbackSku;
        rememberEntries.push({
          sku,
          inventory_item_id: invItemId,
          source: 'webhook-inventory-item',
        });
      }
    }

    if (!sku) {
      if (rememberEntries.length) rememberInventoryItems(rememberEntries);
      return res.status(200).send('ok');
    }

    // 2) buscar item QBD por SKU (prioridades + overrides)
    const inv = loadInventory();
    const fieldsPriority = skuFields();
    const it = resolveSkuToItem(inv.items || [], sku, fieldsPriority);
    if (!it) {
      if (rememberEntries.length) rememberInventoryItems(rememberEntries);
      return res.status(200).send('ok');
    }

    // 3) calcular delta con respecto a QBD (snapshot)
    const qbdQoh = Number(it.QuantityOnHand || 0);
    const delta = available - qbdQoh;
    if (!delta) {
      if (rememberEntries.length) rememberInventoryItems(rememberEntries);
      return res.status(200).send('ok');
    }

    rememberEntries.push({
      sku,
      inventory_item_id: invItemId,
      variant_id: variantMeta?.id,
      source: 'webhook-adjustment',
    });
    rememberInventoryItems(rememberEntries);

    const adjustments = [{
      sku,
      delta,
      available,
      qbdQoh,
      target: available,
      inventory_item_id: invItemId,
      source: 'shopify-inventory-level',
      note: payload?.location_id ? `location ${payload.location_id}` : undefined,
    }];

    const line = it.ListID
      ? { ListID: it.ListID, QuantityDifference: delta }
      : { FullName: it.FullName || it.Name, QuantityDifference: delta };

    const jobId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');

    enqueue({
      id: jobId,
      type: 'inventoryAdjust',
      lines: [line],
      account: process.env.QBD_ADJUST_ACCOUNT || undefined,
      source: 'shopify-inventory-level',
      createdAt: new Date().toISOString(),
      skus: [sku],
      pendingAdjustments: adjustments,
    });

    prioritizeShopifyAdjustments();
    trackPendingAdjustments(jobId, adjustments);

    return res.status(200).json({ ok: true, sku, qbdQoh, available, delta, jobId });
  } catch (e) {
    console.error('inventory_levels/update webhook error:', e);
    return res.status(500).send('error');
  }
});

module.exports = router;
