'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.LOG_DIR || '/tmp';
const JOBS_FILE = path.join(LOG_DIR, 'jobs.json');
const CURRENT_JOB_FILE = path.join(LOG_DIR, 'current-job.json');

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

function enqueueJob(job) {
  if (!job || typeof job !== 'object') return readJobs().length;
  const jobs = readJobs();
  jobs.push(job);
  writeJobs(jobs);
  return jobs.length;
}

function peekJob() {
  const jobs = readJobs();
  return jobs.length ? jobs[0] : null;
}

function popJob() {
  const jobs = readJobs();
  if (!jobs.length) return null;
  const [first, ...rest] = jobs;
  writeJobs(rest);
  return first || null;
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
  enqueueJob,
  peekJob,
  popJob,
  setCurrentJob,
  getCurrentJob,
  clearCurrentJob,
};
