"use strict";

const config = require("../config");
const { resolveFps, parseResolution } = require("./resolution");

/**
 * Normalise the render payload.
 *
 * Backwards compatible: every field the old frontend sent (aspectMode,
 * outputFit, crf, preset, zoom, focusX/Y, overlay, batchIndex …) still works.
 * New optional fields: `fps`, `resolution`, `audio { ... }`.
 */
function extractRenderOptions(body = {}) {
  let aspectMode = String(body.aspectMode || body.aspect_mode || "").toLowerCase();
  if (!aspectMode) {
    const fit = String(body.outputFit || body.output_fit || body.fit || "").toLowerCase();
    const padMode = String(body.padMode || body.pad_mode || "").toLowerCase();
    if (fit === "blur-pad" || padMode === "blur" || truthy(body.blurBackground) || truthy(body.blur_background)) {
      aspectMode = "blurpad";
    } else if (fit === "contain") aspectMode = "fit";
    else if (fit === "cover") aspectMode = "cinematic";
    else aspectMode = "fit";
  }

  let overlay = null;
  try {
    const raw = body.overlay || body.overlayMeta;
    if (raw) overlay = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) {
    overlay = null;
  }
  if (overlay && (overlay.enabled === false || overlay.enabled === "false")) overlay = null;

  return {
    aspectMode,
    overlay,
    zoomPercent: numberOr(body.zoomPercent ?? body.zoom_percent, 18),
    crf: numberOr(body.crf, config.video.crf),
    preset: body.preset || config.video.preset,
    maxrate: body.maxrate || "",
    bufsize: body.bufsize || "",
    audioBitrate: body.audioBitrate || config.audio.bitrate,
    pixFmt: body.pixFmt || config.video.pixFmt,
    videoCodec: body.videoCodec || config.video.codec,
    zoomFactor: numberOr(body.zoomFactor ?? body.zoom, 1),
    focusX: normFocus(body.focusX ?? body.cropX),
    focusY: normFocus(body.focusY ?? body.cropY),
    fpsRequest: body.fps ?? body.frameRate ?? body.frame_rate ?? "auto",
    resolution: parseResolution(body.resolution || body.outputResolution || body.output_resolution),
    audio: extractAudioSettings(body),
  };
}

/**
 * Audio Settings API — flexible by design so new keys can be added without
 * breaking older clients. Anything omitted falls back to a safe default.
 */
function extractAudioSettings(body = {}) {
  const raw = parseMaybeJson(body.audio) || parseMaybeJson(body.audioSettings) || {};
  const bgRaw = parseMaybeJson(raw.backgroundMusic ?? raw.background_music ?? body.backgroundMusic) || {};

  return {
    enabled: raw.enabled !== false && raw.processing !== false,
    speed: clamp(numberOr(raw.audioSpeed ?? raw.speed ?? body.audioSpeed, 1), 0.25, 4),
    voiceVolume: clamp(numberOr(raw.voiceVolume ?? body.voiceVolume, 1), 0, 4),
    normalize: raw.normalize !== false,
    targetLUFS: clamp(numberOr(raw.targetLUFS ?? raw.target_lufs ?? body.targetLUFS, config.audio.targetLUFS), -40, -5),
    voiceEnhancement: truthy(raw.voiceEnhancement ?? raw.voice_enhancement ?? body.voiceEnhancement),
    backgroundMusic: {
      enabled: truthy(bgRaw.enabled),
      track: bgRaw.track || bgRaw.id || null,
      volume: clamp(numberOr(bgRaw.volume, 0.18), 0, 1),
      loop: bgRaw.loop !== false,
      crossfade: clamp(numberOr(bgRaw.crossfade, 2), 0, 10),
      duck: bgRaw.duck !== false,
    },
  };
}

function parseMaybeJson(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch (_) {
    return null;
  }
}

function truthy(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function numberOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function normFocus(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0.5;
  return n > 1 ? n / 100 : n;
}

module.exports = { extractRenderOptions, extractAudioSettings, resolveFps };
