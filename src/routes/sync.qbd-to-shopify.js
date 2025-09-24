// src/routes/sync.qbd-to-shopify.js
const express = require('express');
const { dryRun, apply, LOCK_ERROR_CODE } = require('../services/shopify.sync');

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

module.exports = router;
