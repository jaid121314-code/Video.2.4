"use strict";

const fs = require("fs");
const multer = require("multer");
const path = require("path");
const config = require("../config");
const { randomId, safeName } = require("../utils/files");

/**
 * Resolve the project/panel ids a panel-upload request is for.
 *
 * IMPORTANT: this is called from multer's destination() callback, which
 * fires once per incoming file *as multer streams the multipart body*.
 * express never parses multipart bodies itself, so req.body is only ever
 * populated by multer's own field parser as it goes — meaning any text
 * fields the client appended to the FormData *before* the file fields
 * (project_id/panel_id in this app) are already on req.body by the time
 * the image/audio file arrives, even though the request as a whole hasn't
 * finished parsing yet. Query params (if the client used them) are used
 * first since those are known immediately, before parsing even starts.
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
 * Panel upload writes straight into the panel folder — the old handler wrote
 * the file to /uploads, read it fully back into a Buffer, wrote it again into
 * the panel dir and then unlinked it (3 disk ops + full-file RAM per image).
 */
const panelUpload = multer({
  storage: multer.diskStorage({
    // Resolve the *real* project/panel dir directly, per-file, instead of
    // writing into a temp dir and renaming it after the fact. This is what
    // removes the ENOENT-on-rename race: the file is written straight into
    // its final home the first time, so there is no second folder for a
    // concurrent request to have already moved out from under us.
    destination: (req, file, cb) => {
      if (req._panelDir) return cb(null, req._panelDir); // already resolved for this request (2nd file field)
      const { projectId, panelId } = resolvePanelIds(req);
      if (!projectId || !panelId) {
        return cb(
          new Error(
            "project_id and panel_id must be included as form fields (or query params) BEFORE the image/audio fields in the upload request",
          ),
        );
      }
      const dir = path.join(config.dirs.uploads, projectId, panelId);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        return cb(err);
      }
      req._panelDir = dir;
      req._projectId = projectId;
      req._panelId = panelId;
      cb(null, dir);
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

module.exports = { panelUpload, imagesUpload, zipUpload, overlayUpload, musicUpload };
