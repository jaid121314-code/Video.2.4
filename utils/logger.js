"use strict";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT = LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? 2;

function mem() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function stamp(tag) {
  return tag ? `[${tag}]` : "";
}

const logger = {
  error: (tag, ...a) => CURRENT >= 0 && console.error(stamp(tag), ...a),
  warn: (tag, ...a) => CURRENT >= 1 && console.warn(stamp(tag), ...a),
  info: (tag, ...a) => CURRENT >= 2 && console.log(stamp(tag), ...a),
  debug: (tag, ...a) => CURRENT >= 3 && console.log(stamp(tag), ...a),
  mem,
};

module.exports = { logger, mem };
