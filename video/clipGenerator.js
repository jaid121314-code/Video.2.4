"use strict";

const fs = require("fs");
const config = require("../config");
const { runFfmpeg, threadFlag } = require("../utils/ffmpeg");
const { logger } = require("../utils/logger");
const { kenBurnsFilter, manualZoomFilter, overlayGraph } = require("./filters");
const { buildNarrationChain, silenceInput } = require("../audio/chain");

/**
 * Encode ONE clip (image + processed narration) in a single FFmpeg pass.
 *
 * Previously the pipeline could touch the same media three times: probe,
 * (optional) audio pre-pass, and the clip encode. Now the whole narration
 * chain — speed, loudnorm, enhancement, EQ, compressor, limiter, volume —
 * lives in the same filter graph as the picture, so each source file is
 * decoded exactly once and encoded exactly once.
 */
async function createClip({
  imagePath,
  audioPath,
  duration,
  outPath,
  idx,
  fps,
  width,
  height,
  aspectMode,
  zoomPercent,
  audioSettings = {},
  renderOptions = {},
}) {
  const hasAudio = Boolean(audioPath && fs.existsSync(audioPath));
  const overlayPath =
    renderOptions.overlayPath && fs.existsSync(renderOptions.overlayPath)
      ? renderOptions.overlayPath
      : null;

  let videoChain = kenBurnsFilter({
    idx,
    duration,
    fps,
    width,
    height,
    mode: aspectMode,
    zoomPercent,
  });

  const manual = manualZoomFilter({
    zoomFactor: renderOptions.zoomFactor,
    focusX: renderOptions.focusX,
    focusY: renderOptions.focusY,
    width,
    height,
  });
  if (manual) videoChain = `${videoChain},${manual}`;

  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];

  // Input 0: the still image
  args.push("-loop", "1", "-framerate", String(fps), "-t", String(duration.toFixed(3)), "-i", imagePath);

  // Input 1: narration or generated silence
  if (hasAudio) args.push("-i", audioPath);
  else args.push(...silenceInput(duration));

  // Input 2 (optional): overlay PNG
  if (overlayPath) args.push("-i", overlayPath);

  const audioChain = buildNarrationChain(audioSettings);
  const audioGraph = `[1:a]${audioChain.join(",")}[aout]`;

  if (overlayPath) {
    const graph = overlayGraph({ baseChain: videoChain, overlay: renderOptions.overlay, width, inputIndex: 2 });
    args.push("-filter_complex", `${graph};${audioGraph}`, "-map", "[outv]", "-map", "[aout]");
  } else {
    args.push("-filter_complex", `[0:v]${videoChain}[outv];${audioGraph}`, "-map", "[outv]", "-map", "[aout]");
  }

  const crf = Math.max(16, Math.min(30, parseInt(renderOptions.crf, 10) || config.video.crf));

  args.push(
    "-c:v", renderOptions.videoCodec || config.video.codec,
    "-pix_fmt", renderOptions.pixFmt || config.video.pixFmt,
    "-r", String(fps),
    "-g", String(fps * 2),
    "-crf", String(crf),
    "-preset", renderOptions.preset || config.video.preset,
    "-tune", "stillimage",
    "-threads", threadFlag(),
    "-c:a", "aac",
    "-b:a", renderOptions.audioBitrate || config.audio.bitrate,
    "-ar", String(config.audio.sampleRate),
    "-ac", "2",
    // Every clip must share identical stream parameters so the final join can
    // stay a lossless stream-copy.
    "-video_track_timescale", String(fps * 1000),
    "-t", duration.toFixed(3),
    "-movflags", "+faststart",
    "-y", outPath,
  );

  if (renderOptions.maxrate) args.splice(args.length - 2, 0, "-maxrate", String(renderOptions.maxrate));
  if (renderOptions.bufsize) args.splice(args.length - 2, 0, "-bufsize", String(renderOptions.bufsize));

  await runFfmpeg(args, `clip ${idx + 1}`);
  return outPath;
}

/** Retry wrapper: backs off on OOM, then reports failure instead of throwing. */
async function createClipSafe(params, { retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await createClip(params);
      return { success: true };
    } catch (err) {
      lastErr = err;
      logger.warn("clip", `#${params.idx + 1} attempt ${attempt}/${retries} failed: ${err.message.split("\n")[0]}`);
      if (err.oom) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return { success: false, error: lastErr?.message || "clip failed" };
}

module.exports = { createClip, createClipSafe };
