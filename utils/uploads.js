"use strict";

const fs = require("fs");
const multer = require("multer");
const path = require("path");
const config = require("../config");
const { randomId, safeName } = require("../utils/files");

/**
 * Resolve the project/panel ids a panel-upload request is for. Called from
 * the route handler AFTER multer has fully parsed the request (see the
 * memoryStorage comment on panelUpload below for why), so req.body is
 * always complete here regardless of what order the client sent fields in.
 */
function resolvePanelIds(req) {
  const projectId = safeName(
    req.query.project_id || req.query.projectId || req.body?.project_id || req.body?.projectId,
    null,
  );
  const panelId = safeName(
    req.query.panel_id || req.query.panelId || req.body?.panel_id || req.body?.panelId,
    null,
  );
  return { projectId, panelId };
}

function diskStorage(destination, prefix) {
  return multer.diskStorage({
    destination,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || "";
      cb(null, `${prefix}_${Date.now()}_${randomId(4)}${ext}`);
    },
  });
}

/**
 * Panel upload buffers image/audio in memory instead of streaming to a
 * per-file destination. This is deliberate: multer parses a multipart
 * request's parts strictly in the order the browser appended them, and
 * different frontends append the id fields and the file fields in
 * different orders — some send ids first, some send the image first. A
 * destination() callback can only see whatever has already been parsed at
 * that instant, so it can never be reliably correct for both orderings.
 * Buffering the (small, single-image/audio) files in RAM and writing them
 * out ourselves once the whole request is fully parsed sidesteps that
 * entirely — by the time our route handler runs, req.body always has
 * every field, no matter what order the client sent them in.
 */
const panelUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.limits.imageFileBytes, files: 4 },
});

const imagesUpload = multer({
  storage: diskStorage(config.dirs.uploads, "img"),
  limits: { fileSize: config.limits.imageFileBytes, files: config.limits.maxImages },
});

const zipUpload = multer({
  storage: diskStorage(config.dirs.temp, "audio_zip"),
  limits: { fileSize: config.limits.zipBytes, files: 1 },
});

const overlayUpload = multer({
  storage: diskStorage(config.dirs.uploads, "overlay"),
  limits: { fileSize: config.limits.overlayBytes },
});

const musicUpload = multer({
  storage: diskStorage(config.dirs.music, "music"),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
});

module.exports = { panelUpload, imagesUpload, zipUpload, overlayUpload, musicUpload, resolvePanelIds };
