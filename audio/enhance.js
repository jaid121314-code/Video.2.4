"use strict";

/**
 * Voice enhancement chain: rumble removal, mud cut, presence lift, air.
 * Plus a broadcast-style compressor for consistent narration level.
 */
function enhanceFilters() {
  return [
    "highpass=f=85",                                  // remove rumble / handling noise
    "equalizer=f=220:t=q:w=1.0:g=-2",                 // de-mud
    "equalizer=f=3000:t=q:w=1.4:g=3",                 // presence / intelligibility
    "equalizer=f=9000:t=q:w=2.0:g=2",                 // air
  ];
}

function compressorFilter() {
  return "acompressor=threshold=-18dB:ratio=3:attack=8:release=180:makeup=2";
}

function deesserFilter() {
  return "equalizer=f=6500:t=q:w=2.0:g=-2";
}

module.exports = { enhanceFilters, compressorFilter, deesserFilter };
