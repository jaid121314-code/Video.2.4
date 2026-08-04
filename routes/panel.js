"use strict";

const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const config = require("../config");
const { safeName, writeJson, readJson } = require("../utils/files");
const { panelUpload } = require("../utils/uploads");
const { logger } = require("../utils/logger");

const router = express.Router();

/** Prepare the destination folder before multer streams the file into it. */
function preparePanelDir(req, res, next) {
  try {
    const projectId = safeName(req.query.project_id || req.query.projectId || req.body?.project_id || req.body?.projectId, "project");
    const panelId = safeName(
      req.query.panel_id || req.query.panelId || req.body?.panel_id || req.body?.panelId || `panel_${Date.now()}`,
      "panel",
    );
    const dir = path.join(config.dirs.uploads, projectId, panelId);
    fs.mkdirSync(dir, { recursive: true });
    req._panelDir = dir;
    req._projectId = projectId;
    req._panelId = panelId;
    next();
  } catch (err) {
    next(err);
  }
}

router.post(
  "/panel",
  preparePanelDir,
  panelUpload.fields([
    { name: "image", maxCount: 1 },
    { name: "audio", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      // Body fields may only be known after multer parsed the form; if the
      // client sent ids in the body (old behaviour) and they differ from the
      // query fallback, move the folder rather than re-uploading.
      const bodyProject = safeName(req.body.project_id || req.body.projectId, req._projectId);
      const bodyPanel = safeName(req.body.panel_id || req.body.panelId, req._panelId);

      let panelDir = req._panelDir;
      if (bodyProject !== req._projectId || bodyPanel !== req._panelId) {
        const target = path.join(config.dirs.uploads, bodyProject, bodyPanel);
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.rm(target, { recursive: true, force: true });
        await fsp.rename(panelDir, target);
        panelDir = target;
      }

      const image = req.files?.image?.[0];
      if (!image) return res.status(400).json({ success: false, error: "Image required" });

      const audio = req.files?.audio?.[0];
      const zoom = clamp(Number(req.body.zoom || req.body.zoomFactor || 1), 1, 3);
      const focusX = normFocus(req.body.focusX ?? req.body.cropX);
      const focusY = normFocus(req.body.focusY ?? req.body.cropY);

      const meta = {
        index: Number(req.body.index || 0),
        duration: Number(req.body.duration || 4),
        narration: String(req.body.narration || "").trim(),
        image: path.basename(image.path),
        audio: audio ? path.basename(audio.path) : null,
        audio_source: audio ? "upload" : null,
        tts_duration: Number(req.body.tts_duration || req.body.ttsDuration || 0) || null,
        tts_provider: req.body.tts_provider || req.body.ttsProvider || null,
        zoom,
        focusX,
        focusY,
        uploaded_at: new Date().toISOString(),
      };

      await writeJson(path.join(panelDir, "metadata.json"), meta);
      logger.debug("panel", `saved ${bodyProject}/${bodyPanel}`);

      res.json({
        success: true,
        panel: bodyPanel,
        panel_id: bodyPanel,
        ref: bodyPanel,
        project_id: bodyProject,
      });
    } catch (err) {
      logger.error("panel", err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

/** Handy for the frontend: list what the backend currently holds. */
router.get("/project/:projectId", async (req, res) => {
  const projectId = safeName(req.params.projectId, "");
  const dir = path.join(config.dirs.uploads, projectId);
  if (!projectId || !fs.existsSync(dir)) {
    return res.status(404).json({ success: false, error: "Project not found" });
  }
  const names = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  const panels = [];
  for (const name of names) {
    const meta = await readJson(path.join(dir, name, "metadata.json"));
    if (meta) panels.push({ panel_id: name, ...meta });
  }
  panels.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  res.json({ success: true, project_id: projectId, panels });
});

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
}
function normFocus(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return n > 1 ? n / 100 : n;
}

module.exports = router;
