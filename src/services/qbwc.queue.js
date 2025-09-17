'use strict';

const fs = require('fs');
const path = require('path');

const { buildInventoryQueryXML } = require('./inventory');
const { buildInventoryAdjustmentXML } = require('./qbd.adjustment');
const { parseInventoryFromQBXML } = require('./inventoryParser');
const { readJobs, peekJob, popJob, enqueue } = require('./jobQueue');
const { clearPendingByJobId, clearPendingBySkus } = require('./pendingAdjustments');

const LOG_DIR = process.env.LOG_DIR || '/tmp';
const CUR_JOB = path.join(LOG_DIR, 'current-job.json');
const QBXML_VERSION_DEFAULT = process.env.QBXML_VER || '16.0';

function ensureLogDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {
    // ignore mkdir errors
  }
}

function filePath(name) {
  return path.join(LOG_DIR, name);
}

function save(name, text) {
  ensureLogDir();
  fs.writeFileSync(filePath(name), text ?? '', 'utf8');
}

function storeCurrentJob(job) {
  if (!job) return;
  ensureLogDir();
  fs.writeFileSync(CUR_JOB, JSON.stringify(job, null, 2), 'utf8');
}

function loadCurrentJob() {
  try {
    const raw = fs.readFileSync(CUR_JOB, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearCurrentJob() {
  try {
    fs.unlinkSync(CUR_JOB);
  } catch {
    // ignore unlink errors
  }
}

function qbxmlFor(job) {
  if (!job || typeof job !== 'object') return '';

  if (job.type === 'inventoryQuery') {
    const hasExplicitMax = Object.prototype.hasOwnProperty.call(job, 'max') && job.respectMax === true;
    const requestedMax = hasExplicitMax ? Number(job.max) : NaN;
    const max = Number.isFinite(requestedMax) && requestedMax > 0 ? Math.floor(requestedMax) : 0;
    return buildInventoryQueryXML(max, QBXML_VERSION_DEFAULT);
  }

  if (job.type === 'inventoryAdjust') {
    const ver = QBXML_VERSION_DEFAULT || '16.0';
    return buildInventoryAdjustmentXML(job.lines || [], job.account, ver);
  }

  if (job.type === 'raw-qbxml' && typeof job.qbxml === 'string') {
    return job.qbxml;
  }

  return '';
}

function shouldAutoPush() {
  const raw = process.env.SHOPIFY_AUTO_PUSH;
  if (raw == null || raw === '') return true;
  return /^(1|true|yes)$/i.test(String(raw).trim());
}

function getTodayRange(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function parseQBDate(value) {
  if (!value) return null;
  const dt = new Date(value);
  return Number.isNaN(dt.valueOf()) ? null : dt;
}

function pickRelevantTimestamp(item) {
  return item?.TimeModified || item?.TimeCreated || null;
}

function filterInventoryForToday(items, now = new Date()) {
  const { start, end } = getTodayRange(now);
  const filtered = (items || []).filter((item) => {
    const stamp = parseQBDate(pickRelevantTimestamp(item));
    return stamp && stamp >= start && stamp < end;
  });
  return { filtered, start, end };
}

function parseInventorySnapshot(qbxml) {
  try {
    const parsed = parseInventoryFromQBXML(qbxml) || {};
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch (err) {
    console.error('Inventory parse error:', err);
    return [];
  }
}

function prepareNextRequest() {
  const job = peekJob();
  if (!job) {
    clearCurrentJob();
    return { qbxml: '', job: null };
  }

  storeCurrentJob(job);
  popJob();
  const qbxml = qbxmlFor(job);

  if (!qbxml) {
    // no qbxml generated: skip job and move on
    console.warn('[qbwc] No QBXML generated for job, skipping', job);
    clearCurrentJob();
    return prepareNextRequest();
  }

  save('last-request-qbxml.xml', qbxml);
  return { qbxml, job };
}

function handleInventoryQueryResponse(resp) {
  const parsedItems = parseInventorySnapshot(resp);
  const { filtered: todaysItems, start, end } = filterInventoryForToday(parsedItems);
  const generatedAt = new Date().toISOString();
  const snapshotPayload = {
    count: todaysItems.length,
    filteredAt: generatedAt,
    filter: {
      mode: 'TimeModifiedSameDay',
      timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      start: start.toISOString(),
      endExclusive: end.toISOString(),
      sourceCount: parsedItems.length,
    },
    items: todaysItems,
    sourceGeneratedAt: generatedAt,
    sourceItems: parsedItems,
  };

  save('last-inventory.json', JSON.stringify(snapshotPayload, null, 2));
  console.log('[inventory] snapshot filtered for today', {
    totalReceived: parsedItems.length,
    kept: todaysItems.length,
    start: start.toISOString(),
    end: end.toISOString(),
  });

  try {
    const statusMatch = resp.match(/<ItemInventoryQueryRs[^>]*statusCode="(\d+)"/i);
    const ok = !statusMatch || statusMatch[1] === '0';
    const auto = shouldAutoPush();

    if (auto && !ok) {
      console.warn('Auto-push skipped due to QuickBooks error status.');
    }

    if (auto && ok && todaysItems.length > 0) {
      const { apply } = require('./shopify.sync');
      setImmediate(() =>
        apply().catch((e) => console.error('Shopify apply error:', e))
      );
    } else if (auto && todaysItems.length === 0) {
      console.log('Auto-push skipped: no inventory changes detected for today.');
    }
  } catch (err) {
    console.error('Auto-push init error:', err);
  }
}

function handleInventoryAdjustResponse(resp, currentJob) {
  try {
    const match = resp.match(/<InventoryAdjustmentAddRs[^>]*statusCode="(\d+)"/i);
    const status = match ? match[1] : null;
    const ok = !match || status === '0';

    if (ok) {
      if (currentJob?.id) {
        clearPendingByJobId(currentJob.id);
      } else if (Array.isArray(currentJob?.skus) && currentJob.skus.length > 0) {
        clearPendingBySkus(currentJob.skus);
      }

      try {
        const remaining = readJobs();
        const hasRefreshQuery = remaining.some((job) => job && job.type === 'inventoryQuery');
        if (!hasRefreshQuery) {
          enqueue({
            type: 'inventoryQuery',
            ts: new Date().toISOString(),
            source: 'shopify-adjust-refresh',
            triggeredBy: currentJob?.id || null,
          });
        }
      } catch (queueErr) {
        console.error('inventoryAdjust refresh enqueue error:', queueErr);
      }
    } else {
      console.warn('[inventoryAdjust] QuickBooks returned status', status, 'for job', currentJob?.id || '(no id)');
    }
  } catch (err) {
    console.error('Pending Shopify adjustment cleanup error:', err);
  }
}

function handleResponse(responseXml) {
  const resp = responseXml || '';
  const ts = Date.now();
  save(`last-response-${ts}.xml`, resp);
  save('last-response.xml', resp);

  const current = loadCurrentJob();

  if (current?.type === 'inventoryQuery') {
    handleInventoryQueryResponse(resp);
  } else if (current?.type === 'inventoryAdjust') {
    handleInventoryAdjustResponse(resp, current);
  }

  clearCurrentJob();

  let progress = 100;
  try {
    const remainingJobs = readJobs();
    if (Array.isArray(remainingJobs) && remainingJobs.length > 0) {
      progress = 0;
    }
  } catch (err) {
    console.error('queue progress check failed:', err);
  }

  return progress;
}

module.exports = {
  prepareNextRequest,
  handleResponse,
  qbxmlFor,
};
