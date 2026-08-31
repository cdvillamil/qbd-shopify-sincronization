// src/routes/sync.qbd-to-shopify.js
const express = require('express');
const {
  dryRun,
  apply,
  LOCK_ERROR_CODE,
  runReconcile,
  readReconcileStatus,
  isReconcileEnabled,
} = require('../services/shopify.sync');

const router = express.Router();

router.get('/qbd-to-shopify/dry-run', async (req, res) => {
  try {
    const r = await dryRun(req.query.limit ? Number(req.query.limit) : undefined);
    res.json(r);
  } catch (e) {
    if (e && e.code === LOCK_ERROR_CODE) {
      const payload = { error: e.message, code: e.code };
      if (e.lock) payload.lock = e.lock;
      res.status(409).json(payload);
    } else {
      res.status(500).json({ error: String(e.message || e) });
    }
  }
});

router.post('/qbd-to-shopify/apply', async (req, res) => {
  try {
    const r = await apply(req.query.limit ? Number(req.query.limit) : undefined);
    res.json(r);
  } catch (e) {
    if (e && e.code === LOCK_ERROR_CODE) {
      const payload = { error: e.message, code: e.code };
      if (e.lock) payload.lock = e.lock;
      res.status(409).json(payload);
    } else {
      res.status(500).json({ error: String(e.message || e) });
    }
  }
});

// Reconciliación completa QBD vs Shopify (por cantidad).
router.get('/reconcile/status', (_req, res) => {
  res.json({ enabled: isReconcileEnabled(), status: readReconcileStatus() || null });
});

// POST /sync/reconcile            -> corrige diferencias
// POST /sync/reconcile?dryRun=1   -> solo reporta, no empuja
// POST /sync/reconcile?limit=50   -> tope de ítems a corregir en esta corrida
router.post('/reconcile', async (req, res) => {
  const dryRunFlag = /^(1|true|yes)$/i.test(String(req.query.dryRun || ''));
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  try {
    const result = await runReconcile({ dryRun: dryRunFlag, limit });
    res.json({ ok: true, result });
  } catch (e) {
    if (e && e.code === LOCK_ERROR_CODE) {
      res.status(409).json({ error: e.message, code: e.code, lock: e.lock || null });
    } else {
      res.status(500).json({ error: String(e?.message || e) });
    }
  }
});

module.exports = router;
