'use strict';

const express = require('express');
const {
  planShopifyAdjustments,
  applyShopifyAdjustments,
} = require('../services/shopify.to.qbd');

const router = express.Router();

router.get('/shopify-to-qbd/dry-run', async (req, res) => {
  try {
    const result = await planShopifyAdjustments({
      locationId: req.query.locationId || undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

router.post('/shopify-to-qbd/apply', async (req, res) => {
  try {
    const result = await applyShopifyAdjustments({
      locationId: req.query.locationId || undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
