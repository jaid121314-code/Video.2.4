"use strict";

const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const config = require("../config");
const { logger, mem } = require("../utils/logger");
const { TempScope, randomId } = require("../utils/files");
const { runFfmpeg, ffmpegPath } = require("../utils/ffmpeg");
const { mergeClips } = require("../video/merge");
const { RESOLUTIONS } = require("../video/resolution");

const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    renderer: config.rendererName,
    ffmpeg: Boolean(ffmpegPath),
    concurrency: config.renderConcurrency,
    memoryMB: mem(),
    uptime: Math.round(process.uptime()),
    capabilities: {
      fps: ["auto", ...config.video.fpsChoices],
      resolutions: Object.keys(RESOLUTIONS),
      audioPipeline: ["speed", "normalize", "enhance", "eq", "compressor", "limiter", "volume"],
      backgroundMusic: true,
      parallelRendering: true,
    },
  });
});

router.get("/", (_req, res) => {
  res.json({ service: "video-renderer", status: "ok", version: "2.4.0" });
});

/**
 * POST /stitch — merge remote part MP4s into one file.
 * Downloads are streamed to disk (never buffered in RAM) and merged with
 * stream-copy, so this stays cheap even for long videos.
 */
router.post("/stitch", async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls.filter(Boolean) : [];
  if (!urls.length) return res.status(400).json({ success: false, error: "urls[] required" });
  if (urls.length === 1) return res.json({ success: true, url: urls[0], video_url: urls[0] });

  const id = randomId(6);
  const scope = new TempScope(`stitch_${id}`);

  try {
    const parts = [];
    for (const [i, url] of urls.entries()) {
      const dest = path.join(config.dirs.temp, `stitch_${id}_${String(i).padStart(3, "0")}.mp4`);
      scope.track(dest);
      await download(url, dest);
      parts.push(dest);
    }

    const outName = `stitched_${id}.mp4`;
    const outPath = path.join(config.dirs.output, outName);
    await mergeClips(parts, outPath);

    const host = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || req.get("host")}`;
    const url = `${host}/output/${outName}`;
    res.json({ success: true, url, video_url: url });
  } catch (err) {
    logger.error("stitch", err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    await scope.dispose();
  }
});

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed (${r.status}) for ${url}`);
  const out = fs.createWriteStream(dest);
  await new Promise((resolve, reject) => {
    const reader = r.body.getReader();
    (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!out.write(Buffer.from(value))) {
          await new Promise((r2) => out.once("drain", r2));
        }
      }
      out.end();
    })().catch(reject);
    out.on("finish", resolve);
    out.on("error", reject);
  });
}

/** Optional convenience: probe a rendered file. */
router.get("/output-info/:name", async (req, res) => {
  const file = path.join(config.dirs.output, path.basename(req.params.name));
  try {
    const stat = await fsp.stat(file);
    res.json({ success: true, bytes: stat.size, modified: stat.mtime });
  } catch (_) {
    res.status(404).json({ success: false, error: "Not found" });
  }
});

module.exports = { router, runFfmpeg };
