"use strict";

const crypto = require("crypto");
const config = require("../config");

const jobs = new Map();

function createJob(extra = {}) {
  const id = crypto.randomBytes(8).toString("hex");
  jobs.set(id, {
    jobId: id,
    status: "queued",
    progress: 0,
    url: null,
    error: null,
    createdAt: new Date().toISOString(),
    ...extra,
  });
  return id;
}

function update(id, patch) {
  const job = jobs.get(id);
  if (job) Object.assign(job, patch);
  return job;
}

function get(id) {
  return jobs.get(id) || null;
}

/** Bounded eviction sweep — replaces one setTimeout per job (leak on Railway). */
function startEviction() {
  const t = setInterval(() => {
    const cutoff = Date.now() - config.retention.jobTtlMs;
    for (const [id, job] of jobs) {
      if (new Date(job.createdAt).getTime() < cutoff) jobs.delete(id);
    }
  }, 10 * 60 * 1000);
  t.unref?.();
}

module.exports = { createJob, update, get, jobs, startEviction };
