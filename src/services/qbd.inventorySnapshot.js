'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_DIR = '/tmp';
const FILE_NAME = 'last-inventory.json';

function resolveLogDir() {
  const dir = (process.env.LOG_DIR || DEFAULT_LOG_DIR).trim() || DEFAULT_LOG_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function filePath() {
  return path.join(resolveLogDir(), FILE_NAME);
}

function loadInventorySnapshot() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const parsed = JSON.parse(raw) || {};
    const filteredItems = Array.isArray(parsed?.items) ? parsed.items : [];
    let sourceItems = Array.isArray(parsed?.sourceItems) ? parsed.sourceItems : [];

    if (!sourceItems.length && Array.isArray(parsed?.source?.items)) {
      sourceItems = parsed.source.items;
    }

    if (!sourceItems.length) {
      sourceItems = filteredItems;
    }

    return {
      ...parsed,
      items: sourceItems,
      filteredItems,
    };
  } catch {
    return { items: [], filteredItems: [] };
  }
}

module.exports = {
  loadInventorySnapshot,
  filePath,
};
