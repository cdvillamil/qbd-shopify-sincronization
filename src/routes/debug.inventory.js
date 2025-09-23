// routes/debug.inventory.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();

const { LOG_DIR, ensureDir: ensureLogDir } = require('../services/jobQueue');

const SNAP_PATH = path.join(LOG_DIR, 'last-inventory.json');
const LAST_RESP = path.join(LOG_DIR, 'last-response.xml');

// ---------- utils ----------
function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// Normaliza XML que llega HTML-escapado (&lt; ... &gt;) y remueve BOM
function normalizeXml(xml) {
  if (!xml) return '';
  // quitar BOM si existe
  if (xml.charCodeAt(0) === 0xFEFF) xml = xml.slice(1);
  // si parece HTML-escapado, desescapar
  if (xml.includes('&lt;') && xml.includes('&gt;')) {
    xml = xml
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }
  return xml;
}

function extract(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  // ya viene normalizado; mantenemos solo &amp; -> &
  return m[1].replace(/&amp;/g, '&').trim();
}

function parseInventory(xml) {
  xml = normalizeXml(xml);
  if (!xml) return [];

  // Soportamos ItemInventoryRet (puedes añadir otros tipos si usas más queries)
  const blocks = xml.match(/<ItemInventoryRet\b[\s\S]*?<\/ItemInventoryRet>/gi) || [];
  const items = [];
  for (const b of blocks) {
    items.push({
      ListID: extract(b, 'ListID'),
      Name: extract(b, 'Name'),
      FullName: extract(b, 'FullName'),
      BarCodeValue: extract(b, 'BarCodeValue'),
      QuantityOnHand: Number(extract(b, 'QuantityOnHand') || 0) || 0,
    });
  }
  return items;
}

// Devuelve el último XML en LOG_DIR que contenga inventario
function pickLatestInventoryXml() {
  let files = [];
  try {
    ensureLogDir();
    files = fs.readdirSync(LOG_DIR)
      .filter(n => n.endsWith('.xml'))
      .map(n => path.join(LOG_DIR, n))
      .sort((a, b) => {
        try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
      });
  } catch { /* ignore */ }

  for (const f of files) {
    const xml = normalizeXml(read(f));
    if (/<ItemInventoryRet\b/i.test(xml)) {
      const items = parseInventory(xml);
      if (items.length > 0) return { file: f, xml, items };
    }
  }

  // fallback: last-response.xml si (y solo si) tiene inventario
  let xml = normalizeXml(read(LAST_RESP));
  if (/<ItemInventoryRet\b/i.test(xml)) {
    const items = parseInventory(xml);
    if (items.length > 0) return { file: LAST_RESP, xml, items };
  }

  // Nada válido encontrado
  return { file: LAST_RESP, xml: normalizeXml(read(LAST_RESP)), items: [] };
}

// ---------- routes ----------

// Lista lo que hay en LOG_DIR y cuenta ítems por XML
router.get('/scan-xml', (_req, res) => {
  let out = [];
  try {
    ensureLogDir();
    const files = fs.readdirSync(LOG_DIR)
      .filter(n => n.endsWith('.xml'))
      .map(n => path.join(LOG_DIR, n))
      .sort((a, b) => {
        try { return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs; } catch { return 0; }
      });

    out = files.map(f => {
      const xmlRaw = read(f);
      const xml = normalizeXml(xmlRaw);
      const hasInv = /<ItemInventoryRet\b/i.test(xml);
      const count = hasInv ? (xml.match(/<ItemInventoryRet\b/gi) || []).length : 0;
      return { file: f, hasInventory: hasInv, count };
    });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
  res.json({ files: out });
});

// GET /debug/inventory?persist=1&name=...&sku=...
router.get('/inventory', (req, res) => {
  const picked = pickLatestInventoryXml();
  let items = picked.items;

  // filtros opcionales
  const byName = (req.query.name || '').trim();
  const bySku  = (req.query.sku  || '').trim();
  if (byName) items = items.filter(i => i.Name === byName || i.FullName === byName);
  if (bySku)  items = items.filter(i => [i.Name, i.BarCodeValue, i.ListID].includes(bySku));

  const payload = { source: picked.file, count: items.length, items };

  // persistir SOLO si hay ítems
  const persist = /^(1|true|yes)$/i.test(String(req.query.persist || ''));
  if (persist) {
    if (items.length > 0) {
      ensureLogDir();
      fs.writeFileSync(SNAP_PATH, JSON.stringify({ count: items.length, items }, null, 2), 'utf8');
      payload.persisted = SNAP_PATH;
    } else {
      payload.persisted = null;
      payload.note = 'Snapshot NO guardado porque no se encontró inventario en el XML seleccionado.';
    }
  }

  res.json(payload);
});

// GET /debug/snapshot  → muestra lo que usará el sync
router.get('/snapshot', (_req, res) => {
  if (!fs.existsSync(SNAP_PATH)) return res.json({ count: 0, items: [] });
  try {
    const j = JSON.parse(fs.readFileSync(SNAP_PATH, 'utf8'));
    const count = Array.isArray(j.items) ? j.items.length : 0;
    res.json({ count, sample: (j.items || []).slice(0, 5) });
  } catch {
    res.json({ count: 0, items: [] });
  }
});

module.exports = router;