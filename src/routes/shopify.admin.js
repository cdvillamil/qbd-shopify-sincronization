// src/routes/shopify.admin.js
const express = require('express');
const { listLocations } = require('../services/shopify.client');

const router = express.Router();

// GET /shopify/locations  -> lista id, name, active, country, city
router.get('/locations', async (_req, res) => {
  try {
    const locs = await listLocations();
    const slim = locs.map(l => ({
      id: l.id,
      name: l.name,
      active: l.active,
      country: l.country || l.country_code,
      city: l.city,
      address1: l.address1,
      zip: l.zip,
      legacy: l.legacy,
    }));
    res.json({ count: slim.length, locations: slim });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

module.exports = router;