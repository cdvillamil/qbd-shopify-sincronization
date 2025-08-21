// routes/debug.inventory.js
// Expone GET /debug/inventory leyendo el MISMO XML que devuelve /debug/last-response.
// No toca autenticación ni el flujo con QBWC.
// Implementado como "self-call" a tu propio endpoint /debug/last-response para evitar
// depender de rutas internas, variables globales o path en disco.

const express = require('express');
const { parseInventoryFromQBXML } = require('../services/inventoryParser');

const router = express.Router();

// Helper para obtener el XML actual desde tu propio endpoint /debug/last-response
async function fetchLastResponseXML(req) {
  // Usa el host actual para no quemar dominios/puertos
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const url = `${baseUrl}/debug/last-response`;

  // Node 18+ trae fetch global. Si usas Node <18, cambia por axios(request) si ya lo tienes.
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`No se pudo leer /debug/last-response (${res.status}) ${text}`);
  }

  // Dos posibilidades:
  // 1) Respuesta es { xml: "..." }
  // 2) Respuesta es texto XML plano
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await res.json();
    return typeof json.xml === 'string' ? json.xml : JSON.stringify(json);
  }
  return await res.text();
}

// GET /debug/inventory
router.get('/inventory', async (req, res) => {
  try {
    const xml = await fetchLastResponseXML(req);

    const parsed = parseInventoryFromQBXML(xml);

    // Opcional: filtros rápidos por query string (no rompen nada)
    // /debug/inventory?name=AXDI-VW1
    const { name, sku, qmin, qmax } = req.query;
    let items = parsed.items;

    if (name) {
      const n = String(name).toLowerCase();
      items = items.filter(i =>
        (i.Name && i.Name.toLowerCase().includes(n)) ||
        (i.FullName && i.FullName.toLowerCase().includes(n)) ||
        (i.SalesDesc && i.SalesDesc.toLowerCase().includes(n)) ||
        (i.PurchaseDesc && i.PurchaseDesc.toLowerCase().includes(n))
      );
    }
    if (sku) {
      const s = String(sku).toLowerCase();
      items = items.filter(i =>
        (i.BarCodeValue && i.BarCodeValue.toLowerCase().includes(s)) ||
        (i.Name && i.Name.toLowerCase().includes(s))
      );
    }
    if (qmin !== undefined) {
      const v = Number(qmin);
      if (!Number.isNaN(v)) items = items.filter(i => (i.QuantityOnHand ?? -Infinity) >= v);
    }
    if (qmax !== undefined) {
      const v = Number(qmax);
      if (!Number.isNaN(v)) items = items.filter(i => (i.QuantityOnHand ?? Infinity) <= v);
    }

    return res.json({ count: items.length, items });
  } catch (err) {
    console.error('GET /debug/inventory error:', err);
    return res.status(500).json({
      error: 'No se pudo construir el inventario desde el último QBXML',
      details: String(err && err.message ? err.message : err),
    });
  }
});

module.exports = router;
