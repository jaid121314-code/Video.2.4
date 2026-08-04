"use strict";

const config = require("../config");

/**
 * Single-pass EBU R128 loudness normalisation.
 * We deliberately use the one-pass form: a two-pass loudnorm would require an
 * extra full decode of every narration file (the biggest avoidable cost in the
 * old pipeline) for a difference that is inaudible at speech dynamics.
 */
function loudnormFilter({ targetLUFS } = {}) {
  const I = Number.isFinite(Number(targetLUFS)) ? Number(targetLUFS) : config.audio.targetLUFS;
  const clamped = Math.max(-40, Math.min(-5, I));
  return `loudnorm=I=${clamped}:TP=${config.audio.truePeak}:LRA=${config.audio.lra}`;
}

/** Peak-safe fallback used when normalisation is off but limiting is wanted. */
function limiterFilter(level = 0.95) {
  return `alimiter=limit=${level}:level=disabled`;
}

module.exports = { loudnormFilter, limiterFilter };
