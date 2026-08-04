"use strict";

const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const config = require("../config");
const jobStore = require("../jobs/store");
const { safeName, readJson, remove } = require("../utils/files");
const { imagesUpload, overlayUpload } = require("../utils/uploads");
const { extractRenderOptions } = require("../video/options");
const { renderPanels } = require("../video/renderer");
const { logger } = require("../utils/logger");

const router = express.Router();

function hostFor(req) {
  return `https://${process.env.RAILWAY_PUBLIC_DOMAIN || req.get("host")}`;
}

function mergePayloadField(body) {
  if (body && typeof body.payload === "string") {
    try {
      const parsed = JSON.parse(body.payload);
      for (const k of Object.keys(parsed)) if (body[k] == null) body[k] = parsed[k];
    } catch (_) {
      /* ignore */
    }
  }
  return body;
}

// --------------------------------------------------------------------------
// POST /render — JSON (project panels) or multipart (raw images / overlay)
// Response shape is unchanged: { success, jobId, status }
// --------------------------------------------------------------------------

router.post("/render", (req, res) => {
  const ct = String(req.headers["content-type"] || "");
  if (!ct.includes("multipart/form-data")) return dispatch(req, res);

  overlayUpload.fields([
    { name: "overlay", maxCount: 1 },
    { name: "overlayLogo", maxCount: 1 },
    { name: "watermark", maxCount: 1 },
    { name: "music", maxCount: 1 },
  ])(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, error: err.message });
    dispatch(req, res);
  });
});

function dispatch(req, res) {
  mergePayloadField(req.body);

  const overlayFile =
    req.files?.overlay?.[0] || req.files?.overlayLogo?.[0] || req.files?.watermark?.[0] || null;
  req._overlayPath = overlayFile?.path || null;
  req._musicPath = req.files?.music?.[0]?.path || null;

  const projectId = req.body?.project_id || req.body?.projectId;

  if (projectId) {
    const jobId = jobStore.createJob();
    res.json({ success: true, jobId, status: "queued" });
    setImmediate(() => {
      renderFromProject(req, jobId).catch((err) => {
        logger.error("render", err.message);
        jobStore.update(jobId, { status: "error", error: err.message });
      });
    });
    return;
  }

  imagesUpload.fields([{ name: "images", maxCount: config.limits.maxImages }])(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, error: err.message });
    const jobId = jobStore.createJob();
    res.json({ success: true, jobId, status: "queued" });
    setImmediate(() => {
      renderFromMultipart(req, jobId).catch((e) => {
        logger.error("render", e.message);
        jobStore.update(jobId, { status: "error", error: e.message });
      });
    });
  });
}

async function renderFromProject(req, jobId) {
  const projectId = safeName(req.body.project_id || req.body.projectId, "");
  const projectDir = path.join(config.dirs.uploads, projectId);

  if (!projectId || !fs.existsSync(projectDir)) {
    return jobStore.update(jobId, { status: "error", error: `No uploaded panels for project_id ${projectId}` });
  }

  let orderedRefs = [];
  try {
    const raw = req.body.panels;
    orderedRefs = Array.isArray(raw) ? raw : typeof raw === "string" ? JSON.parse(raw) : [];
  } catch (_) {
    orderedRefs = [];
  }

  const load = async (panelId) => {
    const dir = path.join(projectDir, safeName(panelId, ""));
    const meta = await readJson(path.join(dir, "metadata.json"));
    if (!meta) return null;
    return {
      imagePath: path.join(dir, meta.image),
      audioPath: meta.audio ? path.join(dir, meta.audio) : null,
      narration: meta.narration,
      duration: meta.duration,
      ttsDuration: meta.tts_duration,
      zoom: meta.zoom,
      focusX: meta.focusX,
      focusY: meta.focusY,
      index: Number(meta.index || 0),
    };
  };

  let panels;
  if (orderedRefs.length) {
    panels = (await Promise.all(orderedRefs.map((p) => load(p.ref || p.panel_id || p.id || p.panel)))).filter(Boolean);
  } else {
    const dirs = (await fsp.readdir(projectDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    panels = (await Promise.all(dirs.map(load))).filter(Boolean).sort((a, b) => a.index - b.index);
  }

  if (!panels.length) return jobStore.update(jobId, { status: "error", error: "No complete panels found to render" });

  const options = buildOptions(req);
  const batchIndex = Number(req.body.batchIndex || req.body.batch_index || 0);
  const totalBatches = Number(req.body.totalBatches || req.body.total_batches || 1);

  await renderPanels({
    jobId,
    panels,
    options,
    host: hostFor(req),
    meta: { project_id: projectId, batchIndex, totalBatches },
  });

  await remove([req._overlayPath].filter(Boolean));
}

async function renderFromMultipart(req, jobId) {
  const files = req.files?.images || [];
  if (!files.length) return jobStore.update(jobId, { status: "error", error: "No images uploaded." });

  const lines = String(req.body.narration || "").split("\n").map((l) => l.trim());
  while (lines.length < files.length) lines.push("");

  const panels = files.map((f, i) => ({
    imagePath: f.path,
    audioPath: null,
    narration: lines[i] || "",
  }));

  const options = buildOptions(req);
  const batchIndex = Number(req.body.batchIndex || req.body.batch_index || 0);
  const totalBatches = Number(req.body.totalBatches || req.body.total_batches || 1);

  await renderPanels({
    jobId,
    panels,
    options,
    host: hostFor(req),
    meta: { batchIndex, totalBatches },
  });

  await remove([...files.map((f) => f.path), req._overlayPath].filter(Boolean));
}

function buildOptions(req) {
  const options = extractRenderOptions(req.body);
  if (req._overlayPath && fs.existsSync(req._overlayPath)) options.overlayPath = req._overlayPath;
  if (req._musicPath && fs.existsSync(req._musicPath)) {
    options.uploadedMusicPath = req._musicPath;
    options.audio.backgroundMusic.enabled = true;
  }
  return options;
}

// --------------------------------------------------------------------------
// GET /status/:jobId  (unchanged contract)
// --------------------------------------------------------------------------

router.get("/status/:jobId", (req, res) => {
  const job = jobStore.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: "Job not found" });
  res.json({ success: true, ...job });
});

module.exports = router;
