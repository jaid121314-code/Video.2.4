"use strict";

const fsp = require("fs/promises");
const path = require("path");
const config = require("../config");
const { runFfmpeg } = require("../utils/ffmpeg");
const { logger } = require("../utils/logger");

/**
 * Join clips losslessly.
 *
 * All clips are produced with identical codec/fps/timescale/audio parameters,
 * so `-c copy` works: the picture is NEVER re-encoded here. The old code path
 * that re-encoded on concat is gone entirely.
 */
async function mergeClips(clipPaths, outPath) {
  if (!clipPaths.length) throw new Error("No clips to merge");

  if (clipPaths.length === 1) {
    await fsp.copyFile(clipPaths[0], outPath);
    return outPath;
  }

  const listFile = path.join(config.dirs.temp, `concat_${Date.now()}_${Math.random().toString(16).slice(2)}.txt`);
  const body = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");
  await fsp.writeFile(listFile, body, "utf8");

  try {
    await runFfmpeg(
      [
        "-hide_banner", "-loglevel", "error",
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-c", "copy",
        "-movflags", "+faststart",
        "-y", outPath,
      ],
      `lossless merge of ${clipPaths.length} clips`,
    );
  } finally {
    await fsp.rm(listFile, { force: true }).catch(() => {});
  }

  logger.info("merge", `joined ${clipPaths.length} clips → ${path.basename(outPath)}`);
  return outPath;
}

module.exports = { mergeClips };
