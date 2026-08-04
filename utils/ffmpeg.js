"use strict";

const { spawn, spawnSync } = require("child_process");
const { logger } = require("./logger");
const config = require("../config");

// ---------------------------------------------------------------------------
// Binary discovery (runs once at startup, never per request)
// ---------------------------------------------------------------------------

function findBinary(names) {
  for (const bin of names) {
    try {
      const r = spawnSync(bin, ["-version"], { encoding: "utf-8" });
      if (r.status === 0 && String(r.stdout).includes("version")) return bin;
    } catch (_) {
      /* keep looking */
    }
  }
  return null;
}

const FFMPEG_PATH =
  process.env.FFMPEG_PATH ||
  findBinary(["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/ffmpeg/bin/ffmpeg", "ffmpeg"]);

const FFPROBE_PATH =
  process.env.FFPROBE_PATH ||
  (FFMPEG_PATH ? FFMPEG_PATH.replace(/ffmpeg$/, "ffprobe") : null) ||
  "ffprobe";

if (!FFMPEG_PATH) {
  logger.error("ffmpeg", "CRITICAL: FFmpeg is not installed / not on PATH.");
  process.exit(1);
}

logger.info("ffmpeg", `binary: ${FFMPEG_PATH}`);
logger.info("ffmpeg", `probe:  ${FFPROBE_PATH}`);

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

/**
 * Run FFmpeg with raw args. stderr is kept in a bounded ring buffer so long
 * renders cannot grow unbounded strings in memory (old code concatenated the
 * full stderr of every job).
 */
function runFfmpeg(args, description = "ffmpeg", { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    logger.debug("ffmpeg", description, args.join(" "));

    const proc = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "ignore", "pipe"] });
    let tail = "";

    proc.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      tail = (tail + s).slice(-4000); // bounded
      if (onProgress) {
        const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (m) onProgress(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
      }
    });

    proc.on("error", (err) => reject(new Error(`FFmpeg spawn failed: ${err.message}`)));

    proc.on("close", (code, signal) => {
      // Release listeners so the process object can be GC'd promptly.
      proc.stderr.removeAllListeners();
      if (code === 0) return resolve({ stderr: tail });
      // A process killed by the OOM killer (Railway/Linux) reports code=null
      // with signal='SIGKILL' — NOT exit code 137. The old check only ever
      // looked at `code`, so real OOM kills were misreported as generic
      // "failed (code null)" errors and never got the OOM backoff/retry.
      const oom =
        code === 137 ||
        signal === "SIGKILL" ||
        signal === "SIGABRT" ||
        /Cannot allocate memory|Out of memory|ENOMEM/i.test(tail);
      const codeLabel = signal ? `killed by ${signal}${oom ? " — likely OOM" : ""}` : `failed (code ${code})`;
      const err = new Error(`${description} ${codeLabel} — mem=${logger.mem()}MB\n${tail.slice(-800)}`);
      err.oom = oom;
      reject(err);
    });
  });
}

/**
 * ffprobe wrapper returning parsed JSON. Single spawn, no fluent-ffmpeg
 * wrapper object per call.
 */
function probe(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      FFPROBE_PATH,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err = (err + d).slice(-1000)));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed: ${err}`));
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`ffprobe returned invalid JSON: ${e.message}`));
      }
    });
  });
}

// Media metadata is probed once per file and memoised for the lifetime of the
// job — the old code probed the same audio twice (validate + duration).
const metaCache = new Map();

async function probeCached(file) {
  if (metaCache.has(file)) return metaCache.get(file);
  const p = probe(file).catch((e) => {
    metaCache.delete(file);
    throw e;
  });
  metaCache.set(file, p);
  return p;
}

function forgetProbe(file) {
  metaCache.delete(file);
}

async function mediaDuration(file) {
  const data = await probeCached(file);
  const stream = data.streams?.find((s) => s.codec_type === "audio") || data.streams?.[0];
  const d = parseFloat(stream?.duration || data.format?.duration || 0);
  if (!d || d <= 0 || Number.isNaN(d)) throw new Error("Invalid media duration");
  return d;
}

async function imageSize(file) {
  const data = await probeCached(file);
  const v = data.streams?.find((s) => s.codec_type === "video");
  if (!v?.width || !v?.height) throw new Error("Could not read image dimensions");
  return { width: v.width, height: v.height, aspect: v.width / v.height };
}

function threadFlag() {
  return String(config.ffmpegThreads);
}

/** No-op kept so index.js can express intent; discovery already ran above. */
function initFfmpeg() {
  return { ffmpeg: FFMPEG_PATH, ffprobe: FFPROBE_PATH };
}

module.exports = {
  FFMPEG_PATH,
  FFPROBE_PATH,
  ffmpegPath: FFMPEG_PATH,
  ffprobePath: FFPROBE_PATH,
  initFfmpeg,
  runFfmpeg,
  probe,
  probeCached,
  forgetProbe,
  mediaDuration,
  imageSize,
  threadFlag,
};
