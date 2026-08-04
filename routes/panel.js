"use strict";

const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const config = require("../config");
const { safeName, writeJson, readJson } = require("../utils/files");
const { panelUpload, resolvePanelIds } = require("../utils/uploads");
const { logger } = require("../utils/logger");

const router = express.Router();

router.post(
  "/panel",
  panelUpload.fields([
    { name: "image", maxCount: 1 },
    { name: "audio", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      // multer has now fully parsed the request, so req.body has every
      // field the client sent regardless of what order it sent them in.
      const { projectId: bodyProject, panelId: bodyPanel } = resolvePanelIds(req);
      if (!bodyProject || !bodyPanel) {
        return res.status(400).json({ success: false, error: "project_id and panel_id are required" });
      }

      const image = req.files?.image?.[0];
      if (!image) return res.status(400).json({ success: false, error: "Image required" });
      const audio = req.files?.audio?.[0];

      const panelDir = path.join(config.dirs.uploads, bodyProject, bodyPanel);
      await fsp.mkdir(panelDir, { recursive: true });

      const imageName = `image${path.extname(image.originalname || ".jpg").toLowerCase() || ".jpg"}`;
      await fsp.writeFile(path.join(panelDir, imageName), image.buffer);

      let audioName = null;
      if (audio) {
        audioName = `audio${path.extname(audio.originalname || ".mp3").toLowerCase() || ".mp3"}`;
        await fsp.writeFile(path.join(panelDir, audioName), audio.buffer);
      }
      const zoom = clamp(Number(req.body.zoom || req.body.zoomFactor || 1), 1, 3);
      const focusX = normFocus(req.body.focusX ?? req.body.cropX);
      const focusY = normFocus(req.body.focusY ?? req.body.cropY);

      const meta = {
        index: Number(req.body.index || 0),
        duration: Number(req.body.duration || 4),
        narration: String(req.body.narration || "").trim(),
        image: imageName,
        audio: audioName,
        audio_source: audioName ? "upload" : null,
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
