// src/routes/sync.qbd-to-shopify.js
const express = require('express');
const {
  dryRun,
  apply,
  LOCK_ERROR_CODE,
  runReconcile,
  readReconcileStatus,
  isReconcileEnabled,
  isSyncLocked,
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

// POST /sync/reconcile            -> corrige diferencias en segundo plano (202)
// POST /sync/reconcile?dryRun=1   -> solo reporta, no empuja (síncrono)
// POST /sync/reconcile?limit=50   -> tope de ítems a corregir en esta corrida
// POST /sync/reconcile?wait=1     -> espera el resultado (puede exceder el timeout
//                                    de ~230 s del front-end de App Service -> 504)
// El resultado queda en GET /sync/reconcile/status.
router.post('/reconcile', async (req, res) => {
  const dryRunFlag = /^(1|true|yes)$/i.test(String(req.query.dryRun || ''));
  const waitFlag = /^(1|true|yes)$/i.test(String(req.query.wait || ''));
  const limit = req.query.limit ? Number(req.query.limit) : undefined;

  if (!dryRunFlag && !waitFlag) {
    if (isSyncLocked()) {
      return res.status(409).json({ error: 'Shopify sync already running.', code: LOCK_ERROR_CODE });
    }
    setImmediate(() => runReconcile({ dryRun: false, limit }).catch((e) => {
      if (e && e.code === LOCK_ERROR_CODE) console.log('[sync] reconcile skipped: lock busy');
      else console.error('[sync] background reconcile error:', e);
    }));
    return res.status(202).json({
      ok: true,
      started: true,
      note: 'Reconciliación en curso; consulta GET /sync/reconcile/status para ver el resultado.',
    });
  }

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
