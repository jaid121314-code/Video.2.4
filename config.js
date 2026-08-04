"use strict";

const path = require("path");
const os = require("os");

const ROOT = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;

const config = {
  port: Number(process.env.PORT || 8080),
  rendererName: process.env.RENDERER_NAME || "renderer",

  dirs: {
    root: ROOT,
    uploads: path.join(ROOT, "uploads"),
    output: path.join(ROOT, "output"),
    temp: path.join(ROOT, "temp"),
    music: path.join(ROOT, "assets", "music"),
    cache: path.join(ROOT, "temp", "cache"),
  },

  // How many segment encodes may run at once. Each FFmpeg process already
  // uses multiple threads, so we stay conservative on small Railway boxes.
  // Concurrency is capped both by CPU count AND available RAM — a Railway
  // trial box (often 512MB-1GB) can OOM-kill FFmpeg well before it runs out
  // of CPU cores if concurrency is picked from cpu count alone.
  renderConcurrency: Math.max(
    1,
    Number(
      process.env.RENDER_CONCURRENCY ||
        Math.min(
          4,
          Math.max(1, os.cpus().length - 1),
          Math.max(1, Math.floor(os.totalmem() / (768 * 1024 * 1024))), // ~1 encode per 768MB RAM
        ),
    ),
  ),
  // Threads per FFmpeg process (0 = auto/all cores).
  ffmpegThreads: Number(process.env.FFMPEG_THREADS || 0),

  video: {
    defaultFps: Number(process.env.DEFAULT_FPS || 20),
    fpsChoices: [15, 20, 24, 25, 30],
    defaultResolution: process.env.DEFAULT_RESOLUTION || "1280x720",
    crf: Number(process.env.DEFAULT_CRF || 21),
    preset: process.env.DEFAULT_PRESET || "faster",
    pixFmt: "yuv420p",
    codec: "libx264",
  },

  audio: {
    sampleRate: 44100,
    channels: 2,
    bitrate: process.env.AUDIO_BITRATE || "192k",
    targetLUFS: Number(process.env.TARGET_LUFS || -16),
    truePeak: -1.5,
    lra: 11,
    // Music can never be mixed above this level relative to the voice bus.
    maxMusicGain: 0.45,
  },

  retention: {
    // Delete rendered output / temp files older than this (ms).
    fileTtlMs: Number(process.env.FILE_TTL_MS || 2 * 60 * 60 * 1000),
    jobTtlMs: Number(process.env.JOB_TTL_MS || 3 * 60 * 60 * 1000),
    sweepIntervalMs: Number(process.env.SWEEP_INTERVAL_MS || 15 * 60 * 1000),
  },

  limits: {
    imageFileBytes: 500 * 1024 * 1024,
    zipBytes: 1024 * 1024 * 1024,
    overlayBytes: 20 * 1024 * 1024,
    maxImages: 3000,
  },
};

module.exports = config;
