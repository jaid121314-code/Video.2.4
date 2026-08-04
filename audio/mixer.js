"use strict";

const path = require("path");
const config = require("../config");
const { runFfmpeg } = require("../utils/ffmpeg");
const { clampGain } = require("./chain");
const { buildMusicBed, resolveTrack } = require("./musicLoop");
const { logger } = require("../utils/logger");

/**
 * Mix the background music bed under the already-rendered video.
 *
 * IMPORTANT: video is stream-copied (`-c:v copy`) — the picture is never
 * re-encoded, so this step costs seconds even on a one-hour film and adds
 * zero generation loss. Only the audio track is re-encoded once.
 *
 * "Voice always louder than music" is enforced twice:
 *   1. the music gain is hard-capped (config.audio.maxMusicGain), and
 *   2. `sidechaincompress` ducks the music whenever narration is present.
 */
async function mixBackgroundMusic({ videoPath, outPath, music, totalDuration, uploadedTrackPath }) {
  const trackPath = uploadedTrackPath || resolveTrack(music.track);
  if (!trackPath) {
    logger.warn("music", `track not found: ${music.track} — skipping mix`);
    return null;
  }

  const bed = await buildMusicBed({
    trackPath,
    targetDuration: totalDuration,
    loop: music.loop !== false,
    crossfade: Number(music.crossfade ?? 2),
  });

  const requested = Number(music.volume ?? 0.18);
  const gain = Math.min(config.audio.maxMusicGain, Math.max(0, requested));
  const duck = music.duck !== false;

  const graph = [
    `[1:a]volume=${clampGain(gain)},aformat=sample_fmts=fltp:sample_rates=${config.audio.sampleRate}:channel_layouts=stereo[bg]`,
    `[0:a]aformat=sample_fmts=fltp:sample_rates=${config.audio.sampleRate}:channel_layouts=stereo,asplit=2[voice][key]`,
    duck
      ? `[bg][key]sidechaincompress=threshold=0.03:ratio=12:attack=12:release=350:makeup=1[bgduck]`
      : `[bg]anull[bgduck]`,
    `[voice][bgduck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.97:level=disabled[aout]`,
  ].join(";");

  await runFfmpeg(
    [
      "-i", videoPath,
      "-i", bed,
      "-filter_complex", graph,
      "-map", "0:v",
      "-map", "[aout]",
      "-c:v", "copy",
      "-c:a", "aac",
      "-b:a", config.audio.bitrate,
      "-movflags", "+faststart",
      "-shortest",
      "-y", outPath,
    ],
    "background music mix (video stream-copied)",
  );

  return outPath;
}

module.exports = { mixBackgroundMusic };
