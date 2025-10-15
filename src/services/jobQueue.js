'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || '/tmp';
const JOBS_FILE = path.join(LOG_DIR, 'jobs.json');
const CURRENT_JOB_FILE = path.join(LOG_DIR, 'current-job.json');
const JOBS_LOCK_DIR = path.join(LOG_DIR, 'jobs.lock');
const JOBS_LOCK_RETRY_MS = 25;

function ensureDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {
    // noop: directory creation errors will surface later on write attempts
    if (process.env.DEBUG_JOB_QUEUE) {
      console.warn('[jobQueue] mkdir failed:', e);
    }
  }
}

function pruneLogFiles(pattern, { keep = Infinity, maxAgeMs = 0 } = {}) {
  if (!pattern) return 0;

  const matcher =
    pattern instanceof RegExp
      ? (name) => pattern.test(name)
      : typeof pattern === 'function'
      ? pattern
      : typeof pattern === 'string'
      ? (name) => name.includes(pattern)
      : null;

  if (!matcher) {
    throw new TypeError('pruneLogFiles requires a RegExp, string or predicate function');
  }

  ensureDir();

  const now = Date.now();
  const entries = [];

  for (const name of fs.readdirSync(LOG_DIR)) {
    if (!matcher(name)) continue;

    const fullPath = path.join(LOG_DIR, name);
    let ts = 0;

    const tsMatch = name.match(/(\d{5,})/g);
    if (tsMatch && tsMatch.length) {
      const parsedTs = Number(tsMatch[tsMatch.length - 1]);
      if (Number.isFinite(parsedTs)) {
        ts = parsedTs;
      }
    }

    if (!ts) {
      try {
        ts = fs.statSync(fullPath).mtimeMs || 0;
      } catch (err) {
        if (process.env.DEBUG_LOG_RETENTION) {
          console.warn('[jobQueue] pruneLogFiles stat error:', err?.message || err);
        }
      }
    }

    entries.push({ name, fullPath, ts });
  }

  if (!entries.length) return 0;

  entries.sort((a, b) => b.ts - a.ts);

  const limit = Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : Infinity;
  const maxAge = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : 0;

  const toRemove = [];
  for (let idx = 0; idx < entries.length; idx += 1) {
    const entry = entries[idx];
    const beyondLimit = idx >= limit;
    const tooOld = maxAge > 0 && entry.ts > 0 && now - entry.ts > maxAge;

    if (beyondLimit || tooOld) {
      toRemove.push(entry);
    }
  }

  let removed = 0;
  for (const entry of toRemove) {
    try {
      fs.unlinkSync(entry.fullPath);
      removed += 1;
    } catch (err) {
      if (err && err.code !== 'ENOENT' && process.env.DEBUG_LOG_RETENTION) {
        console.warn('[jobQueue] pruneLogFiles unlink error:', {
          file: entry.fullPath,
          error: err?.message || err,
        });
      }
    }
  }

  if (removed > 0 && process.env.DEBUG_LOG_RETENTION) {
    console.log('[jobQueue] pruneLogFiles removed %d file(s) matching pattern', removed);
  }

  return removed;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (process.env.DEBUG_JOB_QUEUE) {
      console.warn('[jobQueue] readJson fallback for', file, e.message || e);
    }
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function readJobs() {
  ensureDir();
  if (!fs.existsSync(JOBS_FILE)) return [];
  const jobs = readJson(JOBS_FILE, []);
  return Array.isArray(jobs) ? jobs : [];
}

function writeJobs(list) {
  writeJson(JOBS_FILE, Array.isArray(list) ? list : []);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withJobsLock(mutator) {
  if (typeof mutator !== 'function') {
    throw new TypeError('withJobsLock requires a mutator function');
  }

  for (;;) {
    ensureDir();
    try {
      fs.mkdirSync(JOBS_LOCK_DIR);
      break;
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        try {
          const stat = fs.statSync(JOBS_LOCK_DIR);
          if (!stat.isDirectory()) {
            fs.rmSync(JOBS_LOCK_DIR, { force: true, recursive: true });
            continue;
          }
        } catch (innerErr) {
          if (innerErr && innerErr.code === 'ENOENT') {
            continue;
          }
          if (process.env.DEBUG_JOB_QUEUE) {
            console.warn('[jobQueue] lock stat error:', innerErr.message || innerErr);
          }
        }
        await sleep(JOBS_LOCK_RETRY_MS);
        continue;
      }
      throw err;
    }
  }

  try {
    const jobs = readJobs();
    const result = await mutator(jobs);
    writeJobs(jobs);
    return result;
  } finally {
    try {
      fs.rmSync(JOBS_LOCK_DIR, { recursive: true, force: true });
    } catch (err) {
      if (err && err.code !== 'ENOENT' && process.env.DEBUG_JOB_QUEUE) {
        console.warn('[jobQueue] lock release error:', err.message || err);
      }
    }
  }
}

async function enqueueJob(job) {
  return withJobsLock(async (jobs) => {
    if (!job || typeof job !== 'object') {
      return jobs.length;
    }
    jobs.push(job);
    return jobs.length;
  });
}

function peekJob() {
  const jobs = readJobs();
  return jobs.length ? jobs[0] : null;
}

async function popJob() {
  return withJobsLock(async (jobs) => {
    if (!jobs.length) return null;
    const first = jobs.shift();
    return first || null;
  });
}

function setCurrentJob(job) {
  if (!job) {
    clearCurrentJob();
    return;
  }
  ensureDir();
  fs.writeFileSync(CURRENT_JOB_FILE, JSON.stringify(job, null, 2), 'utf8');
}

function getCurrentJob() {
  if (!fs.existsSync(CURRENT_JOB_FILE)) return null;
  return readJson(CURRENT_JOB_FILE, null);
}

function clearCurrentJob() {
  try {
    fs.unlinkSync(CURRENT_JOB_FILE);
  } catch (e) {
    if (e && e.code !== 'ENOENT' && process.env.DEBUG_JOB_QUEUE) {
      console.warn('[jobQueue] clearCurrentJob error:', e.message || e);
    }
  }
}

module.exports = {
  LOG_DIR,
  JOBS_FILE,
  CURRENT_JOB_FILE,
  ensureDir,
  readJobs,
  writeJobs,
  withJobsLock,
  enqueueJob,
  peekJob,
  popJob,
  setCurrentJob,
  getCurrentJob,
  clearCurrentJob,
  pruneLogFiles,
};
