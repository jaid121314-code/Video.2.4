"use strict";

const express = require("express");
const path = require("path");
const fsp = require("fs/promises");
const config = require("../config");
const { listLibrary } = require("../audio/musicLoop");
const { musicUpload } = require("../utils/uploads");
const { mediaDuration } = require("../utils/ffmpeg");
const { safeName } = require("../utils/files");
const { logger } = require("../utils/logger");

const router = express.Router();

/** GET /music — library the frontend Music picker renders. */
router.get("/music", async (_req, res) => {
  try {
    const tracks = await listLibrary();
    res.json({ success: true, tracks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** POST /music — add a custom bed to the library. */
router.post("/music", musicUpload.single("music"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: "music file required" });
    const label = safeName(req.body.name || path.parse(req.file.originalname || "track").name, "track");
    const ext = path.extname(req.file.path) || ".mp3";
    const dest = path.join(config.dirs.music, `${label}${ext}`);
    if (dest !== req.file.path) await fsp.rename(req.file.path, dest);

    let duration = 0;
    try {
      duration = await mediaDuration(dest);
    } catch (_) {
      /* non-fatal */
    }

    res.json({ success: true, track: { id: path.basename(dest), name: label, duration } });
  } catch (err) {
    logger.error("music", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/music/:id", async (req, res) => {
  const id = path.basename(String(req.params.id || ""));
  await fsp.rm(path.join(config.dirs.music, id), { force: true }).catch(() => {});
  res.json({ success: true });
});

module.exports = router;
