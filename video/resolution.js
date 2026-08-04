"use strict";

const config = require("../config");

const RESOLUTIONS = {
  "480p": [854, 480],
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "1440p": [2560, 1440],
  "4k": [3840, 2160],
  vertical720: [720, 1280],
  vertical1080: [1080, 1920],
  square1080: [1080, 1080],
};

function parseResolution(value) {
  const raw = String(value || config.video.defaultResolution).toLowerCase().trim();
  if (RESOLUTIONS[raw]) return { width: RESOLUTIONS[raw][0], height: RESOLUTIONS[raw][1] };
  const m = raw.match(/^(\d{3,4})\s*[x×:]\s*(\d{3,4})$/);
  if (m) {
    // H.264 requires even dimensions.
    return { width: even(Number(m[1])), height: even(Number(m[2])) };
  }
  return { width: 1280, height: 720 };
}

function even(n) {
  return n % 2 === 0 ? n : n + 1;
}

/**
 * FPS resolution. Nothing is hardcoded any more: the frontend sends
 * 15 | 20 | 30 | "auto" and every filter, encoder flag and status response
 * uses the resolved value.
 *
 * "auto" balances motion smoothness against render cost:
 *   long videos → 15, medium → 20, short → 30.
 */
function resolveFps(requested, { totalDuration = 0, panelCount = 0 } = {}) {
  const raw = String(requested ?? "").toLowerCase().trim();

  if (raw && raw !== "auto") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 10 && n <= 60) return Math.round(n);
  }

  if (!raw || raw === "auto") {
    const est = totalDuration || panelCount * 6;
    if (est > 25 * 60) return 15;
    if (est > 8 * 60) return 20;
    return 30;
  }

  return config.video.defaultFps;
}

module.exports = { parseResolution, resolveFps, RESOLUTIONS, even };
