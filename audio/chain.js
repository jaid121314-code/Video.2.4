"use strict";

const { atempoChain } = require("./speed");
const { loudnormFilter, limiterFilter } = require("./normalize");
const { enhanceFilters, compressorFilter, deesserFilter } = require("./enhance");
const config = require("../config");

/**
 * Build the complete narration processing chain, in the exact required order:
 *
 *   Upload → Speed → Normalize Loudness → Voice Enhancement → EQ →
 *   Compressor → Limiter → Voice Volume → Processed Narration
 *
 * The whole chain is expressed as ONE FFmpeg filter graph applied during the
 * clip encode. No intermediate WAV/MP3 files are written and the narration is
 * decoded exactly once (previously it was decoded for probing, again for any
 * pre-processing, and a third time for the clip).
 */
function buildNarrationChain(audio = {}) {
  const enabled = audio.enabled !== false && audio.processing !== false;
  const filters = [];

  // Always land on a predictable format for the encoder.
  filters.push(`aformat=sample_fmts=fltp:sample_rates=${config.audio.sampleRate}:channel_layouts=stereo`);

  if (!enabled) {
    const flat = Number(audio.voiceVolume);
    if (Number.isFinite(flat) && Math.abs(flat - 1) > 0.001) filters.push(`volume=${clampGain(flat)}`);
    return filters;
  }

  // 1. Speed
  filters.push(...atempoChain(audio.speed ?? audio.audioSpeed ?? 1));

  // 2. Normalize loudness
  if (audio.normalize !== false) {
    filters.push(loudnormFilter({ targetLUFS: audio.targetLUFS }));
  }

  // 3./4. Voice enhancement + EQ
  if (audio.voiceEnhancement) {
    filters.push(...enhanceFilters(), deesserFilter());
  }

  // 5. Compressor
  if (audio.voiceEnhancement || audio.compressor) {
    filters.push(compressorFilter());
  }

  // 6. Limiter (always — protects against clipping after makeup gain)
  filters.push(limiterFilter(0.96));

  // 7. Voice volume
  const gain = Number(audio.voiceVolume ?? audio.volume ?? 1);
  if (Number.isFinite(gain) && Math.abs(gain - 1) > 0.001) {
    filters.push(`volume=${clampGain(gain)}`);
  }

  return filters;
}

function clampGain(v) {
  return Math.max(0, Math.min(4, Number(v) || 1)).toFixed(3);
}

/** Silent stereo source used when a panel has no narration. */
function silenceInput(duration) {
  return [
    "-f", "lavfi",
    "-t", String(duration),
    "-i", `anullsrc=channel_layout=stereo:sample_rate=${config.audio.sampleRate}`,
  ];
}

module.exports = { buildNarrationChain, silenceInput, clampGain };
