"use strict";

/**
 * Audio speed (tempo) without pitch change.
 * FFmpeg's atempo only accepts 0.5–2.0 per instance, so wide ranges are
 * chained. Returns an array of filter strings (empty when speed === 1).
 */
function atempoChain(speed) {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0 || Math.abs(s - 1) < 0.001) return [];
  const clamped = Math.max(0.25, Math.min(4, s));
  const parts = [];
  let remaining = clamped;
  while (remaining > 2.0) {
    parts.push("atempo=2.0");
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    parts.push("atempo=0.5");
    remaining /= 0.5;
  }
  parts.push(`atempo=${remaining.toFixed(4)}`);
  return parts;
}

/** Duration of `seconds` of audio after applying `speed`. */
function scaledDuration(seconds, speed) {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return seconds;
  return seconds / Math.max(0.25, Math.min(4, s));
}

module.exports = { atempoChain, scaledDuration };
