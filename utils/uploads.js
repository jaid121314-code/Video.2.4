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
 * Panel upload streams straight to a per-request temp folder on disk — NOT
 * RAM. (An earlier version of this fix used multer's memoryStorage to
 * sidestep field-order issues, but that meant every image+audio buffer sat
 * in RAM for the life of the request. Fine for a handful of uploads; with
 * hundreds of concurrent panel uploads it's exactly the kind of memory
 * pressure that OOM-crashes the whole process, not just one FFmpeg clip —
 * which looks like the server randomly restarting mid-batch.)
 *
 * The temp dir name is a random per-request id, NOT the project/panel id —
 * so, unlike the original bug, there's nothing for two concurrent requests
 * to collide on. The route handler moves (renames — same volume, so it's
 * instant) the finished files into the real project/panel folder once
 * multer has fully parsed the request and the ids are known, regardless of
 * what order the client sent fields in.
 */
const panelUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      if (req._panelTempDir) return cb(null, req._panelTempDir); // 2nd file field, same request
      const dir = path.join(config.dirs.temp, `panel_${Date.now()}_${randomId(6)}`);
      fs.mkdir(dir, { recursive: true }, (err) => {
        if (err) return cb(err);
        req._panelTempDir = dir;
        cb(null, dir);
      });
    },
    filename: (_req, file, cb) => {
      if (file.fieldname === "image") return cb(null, `image${path.extname(file.originalname || ".jpg").toLowerCase() || ".jpg"}`);
      cb(null, `audio${path.extname(file.originalname || ".mp3").toLowerCase() || ".mp3"}`);
    },
  }),
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
