"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const { logger } = require("./logger");

function ensureDirs() {
  for (const dir of Object.values(config.dirs)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function safeName(value, fallback) {
  const raw = String(value || fallback || "").trim();
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || fallback;
}

function extFor(file, fallback) {
  const original = file?.originalname ? path.extname(file.originalname) : "";
  if (original) return original.toLowerCase();
  const mime = (file?.mimetype || "").toLowerCase();
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("png")) return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("wav")) return ".wav";
  if (mime.includes("mpeg") || mime.includes("mp3")) return ".mp3";
  if (mime.includes("m4a") || mime.includes("aac")) return ".m4a";
  if (mime.includes("mp4")) return ".mp4";
  return fallback;
}

function randomId(bytes = 8) {
  return crypto.randomBytes(bytes).toString("hex");
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

/** Non-blocking best-effort delete of a list of paths. */
async function remove(files = []) {
  await Promise.all(
    [].concat(files).filter(Boolean).map((f) => fsp.rm(f, { force: true, recursive: true }).catch(() => {})),
  );
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fsp.writeFile(file, JSON.stringify(data, null, 2));
}

function readJsonSync(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

/**
 * Tracks every temp artefact produced by one job so a single call cleans up
 * even when the render throws half-way (the old code leaked segments on some
 * error paths).
 */
class TempScope {
  constructor(tag) {
    this.tag = tag;
    this.files = new Set();
  }
  track(...files) {
    files.flat().filter(Boolean).forEach((f) => this.files.add(f));
    return files[0];
  }
  untrack(file) {
    this.files.delete(file);
  }
  async dispose() {
    const list = [...this.files];
    this.files.clear();
    if (list.length) logger.debug("cleanup", `${this.tag}: removing ${list.length} temp files`);
    await remove(list);
  }
}

module.exports = {
  ensureDirs,
  safeName,
  extFor,
  randomId,
  exists,
  remove,
  readJson,
  writeJson,
  readJsonSync,
  TempScope,
  fsp,
  path,
};
