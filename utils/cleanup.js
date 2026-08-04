"use strict";

const fsp = require("fs/promises");
const path = require("path");
const config = require("../config");
const { logger } = require("./logger");

let timer = null;

async function sweepDir(dir, ttlMs) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      const stat = await fsp.stat(full);
      if (now - stat.mtimeMs > ttlMs) {
        await fsp.rm(full, { force: true, recursive: true });
        removed++;
      }
    } catch (_) {
      /* ignore */
    }
  }
  return removed;
}

/** Periodic async sweep. The old version used blocking readdirSync/statSync. */
function startCleanupLoop() {
  if (timer) return;
  const { fileTtlMs, sweepIntervalMs } = config.retention;
  const run = async () => {
    let total = 0;
    for (const dir of [config.dirs.output, config.dirs.temp]) {
      total += await sweepDir(dir, fileTtlMs);
    }
    // Uploaded project panels live longer than a single render but must not
    // accumulate forever on Railway's ephemeral disk.
    total += await sweepDir(config.dirs.uploads, fileTtlMs * 3);
    if (total) logger.info("cleanup", `removed ${total} stale files`);
  };
  timer = setInterval(() => run().catch(() => {}), sweepIntervalMs);
  timer.unref?.();
  run().catch(() => {});
}

function stopCleanupLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startCleanupLoop, stopCleanupLoop, sweepDir };
