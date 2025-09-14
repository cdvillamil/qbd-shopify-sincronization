// routes/debug.inventory.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const router = express.Router();

const TMP_DIR = '/tmp';
const SNAP_PATH = path.join(TMP_DIR, 'last-inventory.json');
const LAST_RESP = path.join(TMP_DIR, 'last-response.xml');

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function extract(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';
  return m[1].replace(/&amp;/g, '&').trim();
}

function parseInventory(xml) {
  const items = [];
  const blocks = xml.match(/<ItemInventoryRet\b[\s\S]*?<\/ItemInventoryRet>/gi) || [];
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

function pickLatestInventoryXml() {
  // 1) si pasan src explícito
  const src = (reqSrc) => (reqSrc && fs.existsSync(reqSrc) ? reqSrc : null);

  // 2) escanea /tmp por last-response-*.xml y elige el más nuevo que contenga ItemInventoryRet
  const files = fs.readdirSync(TMP_DIR)
    .filter(n => n.startsWith('last-response') && n.endsWith('.xml'))
    .map(n => path.join(TMP_DIR, n))
    .sort((a,b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  for (const f of files) {
    const xml = read(f);
    if (/<ItemInventoryRet\b/i.test(xml)) return { file: f, xml };
  }

  // 3) fallback al last-response.xml tradicional
  return { file: LAST_RESP, xml: read(LAST_RESP) };
}

// GET /debug/inventory  (opcional: ?persist=1&name=...&sku=...&src=/tmp/last-response-XXXX.xml)
router.get('/inventory', (req, res) => {
  let from = req.query.src && fs.existsSync(req.query.src)
    ? { file: req.query.src, xml: read(req.query.src) }
    : pickLatestInventoryXml();

  const xml = from.xml || '';
  let items = parseInventory(xml);

  // filtros opcionales
  const byName = (req.query.name || '').trim();
  const bySku  = (req.query.sku  || '').trim();
  if (byName) items = items.filter(i => i.Name === byName || i.FullName === byName);
  if (bySku)  items = items.filter(i => [i.Name, i.BarCodeValue, i.ListID].includes(bySku));

  const payload = { source: from.file, count: items.length, items };

  // persistir si lo piden
  const persist = /^(1|true|yes)$/i.test(String(req.query.persist || ''));
  if (persist) {
    fs.writeFileSync(SNAP_PATH, JSON.stringify({ count: items.length, items }, null, 2), 'utf8');
  }

  res.json(payload);
});

// GET /debug/snapshot  → ver lo último que usará shopify.sync.js
router.get('/snapshot', (_req, res) => {
  if (!fs.existsSync(SNAP_PATH)) return res.json({ count: 0, items: [] });
  try {
    const j = JSON.parse(fs.readFileSync(SNAP_PATH, 'utf8'));
    res.json({ count: Array.isArray(j.items) ? j.items.length : 0, sample: (j.items || []).slice(0, 5) });
  } catch {
    res.json({ count: 0, items: [] });
  }
});

module.exports = router;