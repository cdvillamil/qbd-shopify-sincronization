// src/routes/sync.qbd-to-shopify.js
const express = require('express');
const { dryRun, apply } = require('../services/shopify.sync');

const router = express.Router();

router.get('/qbd-to-shopify/dry-run', async (req, res) => {
  try { const r = await dryRun(req.query.limit ? Number(req.query.limit) : undefined); res.json(r); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

router.post('/qbd-to-shopify/apply', async (req, res) => {
  try { const r = await apply(req.query.limit ? Number(req.query.limit) : undefined); res.json(r); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

module.exports = router;