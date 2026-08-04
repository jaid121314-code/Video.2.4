"use strict";

const multer = require("multer");
const path = require("path");
const config = require("../config");
const { randomId } = require("../utils/files");

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
    destination: (req, file, cb) => {
      const dir = req._panelDir;
      if (!dir) return cb(new Error("panel directory not prepared"));
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
