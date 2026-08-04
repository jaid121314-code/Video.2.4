"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const { runFfmpeg, mediaDuration } = require("../utils/ffmpeg");
const { logger } = require("../utils/logger");

/** Tracks shipped with the image (assets/music) + anything uploaded there. */
async function listLibrary() {
  try {
    const files = await fsp.readdir(config.dirs.music);
    return files
      .filter((f) => /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(f))
      .sort()
      .map((f) => ({
        id: f,
        name: path.parse(f).name.replace(/[_-]+/g, " "),
        url: `/music/${encodeURIComponent(f)}`,
      }));
  } catch (_) {
    return [];
  }
}

function resolveTrack(track) {
  if (!track) return null;
  const base = path.basename(String(track));
  const full = path.join(config.dirs.music, base);
  return fs.existsSync(full) ? full : null;
}

/**
 * Produce a music bed of exactly `targetDuration` seconds.
 *
 * - loop off        → track is used as-is (trimmed / padded with silence)
 * - loop on, xf = 0 → `-stream_loop` (zero decode of extra copies, cheapest)
 * - loop on, xf > 0 → repeated inputs joined with `acrossfade`
 *
 * The bed is produced ONCE per (track, duration, settings) and cached on disk,
 * so re-renders of the same project skip the work entirely.
 */
async function buildMusicBed({ trackPath, targetDuration, loop = true, crossfade = 0 }) {
  const dur = await mediaDuration(trackPath);
  const xf = Math.max(0, Math.min(10, Number(crossfade) || 0));
  const key = crypto
    .createHash("sha1")
    .update([trackPath, dur.toFixed(2), targetDuration.toFixed(2), loop, xf].join("|"))
    .digest("hex")
    .slice(0, 16);

  const out = path.join(config.dirs.cache, `music_${key}.m4a`);
  if (fs.existsSync(out)) {
    logger.info("music", `cache hit for bed ${key}`);
    return out;
  }

  await fsp.mkdir(config.dirs.cache, { recursive: true });
  const args = [];

  if (!loop || dur >= targetDuration) {
    args.push("-i", trackPath);
    args.push("-filter_complex", `[0:a]atrim=0:${targetDuration.toFixed(3)},asetpts=N/SR/TB,afade=t=out:st=${Math.max(0, targetDuration - 2).toFixed(3)}:d=2[out]`);
  } else if (xf <= 0) {
    // Cheapest possible loop: FFmpeg repeats the demuxed packets, no extra
    // decode of a concatenated temp file (the old approach wrote a temp WAV).
    args.push("-stream_loop", "-1", "-i", trackPath);
    args.push("-filter_complex", `[0:a]atrim=0:${targetDuration.toFixed(3)},asetpts=N/SR/TB,afade=t=out:st=${Math.max(0, targetDuration - 2).toFixed(3)}:d=2[out]`);
  } else {
    const step = Math.max(1, dur - xf);
    const copies = Math.min(90, Math.ceil(targetDuration / step) + 1);
    for (let i = 0; i < copies; i++) args.push("-i", trackPath);

    const chain = [];
    let cur = "[0:a]";
    for (let i = 1; i < copies; i++) {
      const label = i === copies - 1 ? "[xfin]" : `[x${i}]`;
      chain.push(`${cur}[${i}:a]acrossfade=d=${xf}:c1=tri:c2=tri${label}`);
      cur = label;
    }
    chain.push(
      `${cur}atrim=0:${targetDuration.toFixed(3)},asetpts=N/SR/TB,afade=t=out:st=${Math.max(0, targetDuration - 2).toFixed(3)}:d=2[out]`,
    );
    args.push("-filter_complex", chain.join(";"));
  }

  args.push(
    "-map", "[out]",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", String(config.audio.sampleRate),
    "-ac", "2",
    "-y", out,
  );

  await runFfmpeg(args, "background music bed");
  return out;
}

module.exports = { listLibrary, resolveTrack, buildMusicBed };
