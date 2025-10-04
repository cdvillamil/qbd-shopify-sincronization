// src/routes/sync.qbd-to-shopify.js
const express = require('express');
const {
  dryRun,
  apply,
  LOCK_ERROR_CODE,
  runInitialSweepIfNeeded,
  readInitialSweepUnmatchedQbd,
  readInitialSweepUnmatchedShopify,
  readInitialSweepStatus,
  isInitialSweepEnabled,
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

router.get('/initial/status', (_req, res) => {
  const status = readInitialSweepStatus();
  res.json({
    enabled: isInitialSweepEnabled(),
    status: status || null,
  });
});

router.post('/initial/run', async (_req, res) => {
  if (!isInitialSweepEnabled()) {
    res.status(409).json({
      error: 'Initial sweep is disabled by environment configuration.',
    });
    return;
  }

  try {
    const result = await runInitialSweepIfNeeded();
    res.json({ ok: true, result: result || null });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

router.get('/initial/unmatched/qbd', (req, res) => {
  const data = readInitialSweepUnmatchedQbd();
  if (!data) {
    res.status(404).json({ error: 'Initial sweep QBD unmatched data not available.' });
    return;
  }
  res.json(data);
});

router.get('/initial/unmatched/shopify', (req, res) => {
  const data = readInitialSweepUnmatchedShopify();
  if (!data) {
    res.status(404).json({ error: 'Initial sweep Shopify unmatched data not available.' });
    return;
  }
  res.json(data);
});

module.exports = router;
