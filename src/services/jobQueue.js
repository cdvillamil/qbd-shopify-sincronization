'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_DIR = '/tmp';
const DEFAULT_QUEUE_FILE = 'jobs.json';

function resolveLogDir() {
  const dir = (process.env.LOG_DIR || DEFAULT_LOG_DIR).trim() || DEFAULT_LOG_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function queueFilePath() {
  return path.join(resolveLogDir(), DEFAULT_QUEUE_FILE);
}

function readJobs() {
  try {
    const raw = fs.readFileSync(queueFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function writeJobs(list) {
  const payload = Array.isArray(list) ? list : [];
  fs.writeFileSync(queueFilePath(), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function enqueue(job) {
  if (!job || typeof job !== 'object') return readJobs();
  const jobs = readJobs();
  jobs.push(job);
  writeJobs(jobs);
  return jobs.length;
}

function prioritizeJobs(predicate) {
  if (typeof predicate !== 'function') return readJobs();
  const jobs = readJobs();
  if (jobs.length <= 1) return jobs;

  const prioritized = [];
  const rest = [];
  for (const job of jobs) {
    if (predicate(job)) {
      prioritized.push(job);
    } else {
      rest.push(job);
    }
  }

  if (prioritized.length === 0 || rest.length === 0) {
    return jobs;
  }

  const next = prioritized.concat(rest);
  writeJobs(next);
  return next;
}

function peekJob() {
  const jobs = readJobs();
  return jobs.length > 0 ? jobs[0] : null;
}

function popJob() {
  const jobs = readJobs();
  if (jobs.length === 0) return null;
  const job = jobs.shift();
  writeJobs(jobs);
  return job;
}

module.exports = {
  queueFilePath,
  readJobs,
  writeJobs,
  enqueue,
  peekJob,
  popJob,
  prioritizeJobs,
};
