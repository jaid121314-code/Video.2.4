"use strict";

const path = require("path");
const fs = require("fs");
const config = require("../config");
const jobStore = require("../jobs/store");
const { logger } = require("../utils/logger");
const { TempScope, remove, randomId } = require("../utils/files");
const { mapLimit } = require("../utils/concurrency");
const { mediaDuration, forgetProbe } = require("../utils/ffmpeg");
const { resolveFps } = require("./resolution");
const { createClipSafe } = require("./clipGenerator");
const { mergeClips } = require("./merge");
const { mixBackgroundMusic } = require("../audio/mixer");
const { scaledDuration } = require("../audio/speed");

const PADDING = 0.2;

/**
 * Resolve each panel's duration.
 *
 * Audio files are probed ONCE here; the result is reused for validation,
 * duration maths and the encode (the old code probed the same file twice).
 * Narration speed is taken into account so the picture never outlasts the
 * sped-up voice.
 */
async function resolveDurations(panels, audioSettings) {
  const speed = audioSettings?.enabled === false ? 1 : audioSettings?.speed || 1;

  return Promise.all(
    panels.map(async (p, i) => {
      if (p.audioPath && fs.existsSync(p.audioPath)) {
        try {
          const raw = await mediaDuration(p.audioPath);
          return scaledDuration(raw, speed) + PADDING;
        } catch (err) {
          throw new Error(`Panel ${i + 1} audio unreadable: ${err.message}`);
        }
      }
      if (Number.isFinite(Number(p.ttsDuration)) && Number(p.ttsDuration) > 0) {
        return scaledDuration(Number(p.ttsDuration), speed) + PADDING;
      }
      if (p.narration) {
        const words = String(p.narration).split(/\s+/).filter(Boolean).length;
        return Math.max(3, Math.min(12, Math.round(words / 2.3) + 1));
      }
      return Number(p.duration) > 0 ? Number(p.duration) : 4;
    }),
  );
}

/**
 * The whole render: clips → merge → optional music mix.
 *
 * @param {Array<{imagePath, audioPath, narration, zoom, focusX, focusY}>} panels
 */
async function renderPanels({ jobId, panels, options, host, meta = {} }) {
  const scope = new TempScope(jobId);
  const started = Date.now();

  try {
    if (!panels.length) throw new Error("No panels to render");

    for (const [i, p] of panels.entries()) {
      if (!p.imagePath || !fs.existsSync(p.imagePath)) {
        throw new Error(`Panel ${i + 1} image missing`);
      }
    }

    jobStore.update(jobId, { status: "processing", progress: 2, message: "Analysing narration" });

    const durations = await resolveDurations(panels, options.audio);
    const totalDuration = durations.reduce((a, b) => a + b, 0);
    const fps = resolveFps(options.fpsRequest, { totalDuration, panelCount: panels.length });
    const { width, height } = options.resolution;

    logger.info(
      "render",
      `${jobId}: ${panels.length} panels · ${totalDuration.toFixed(1)}s · ${width}x${height}@${fps} · concurrency=${config.renderConcurrency}`,
    );

    jobStore.update(jobId, { fps, resolution: `${width}x${height}`, totalDuration: Number(totalDuration.toFixed(2)) });

    // ---- Clip generation (parallel, bounded) -------------------------------
    let completed = 0;
    let skipped = 0;

    const results = await mapLimit(panels, config.renderConcurrency, async (p, i) => {
      const outPath = path.join(config.dirs.temp, `clip_${jobId}_${String(i).padStart(4, "0")}.mp4`);
      scope.track(outPath);

      const r = await createClipSafe({
        imagePath: p.imagePath,
        audioPath: p.audioPath || null,
        duration: durations[i],
        outPath,
        idx: i,
        fps,
        width,
        height,
        aspectMode: options.aspectMode,
        zoomPercent: options.zoomPercent,
        audioSettings: options.audio,
        renderOptions: {
          ...options,
          zoomFactor: p.zoom ?? options.zoomFactor,
          focusX: p.focusX ?? options.focusX,
          focusY: p.focusY ?? options.focusY,
        },
      });

      completed++;
      if (!r.success) skipped++;
      jobStore.update(jobId, {
        progress: Math.round((completed / panels.length) * 78) + 2,
        message: `Rendered ${completed}/${panels.length} clips`,
        skipped,
      });

      // Free the probe cache entry for this panel's media as soon as it is done.
      if (p.audioPath) forgetProbe(p.audioPath);
      forgetProbe(p.imagePath);

      return r.success ? outPath : null;
    });

    const clipPaths = results.filter(Boolean);
    if (!clipPaths.length) throw new Error("All panels failed to render — no clips produced.");
    if (skipped > 0) {
      logger.error(
        "render",
        `${jobId}: ${skipped}/${panels.length} panel clip(s) FAILED and were dropped from the final video (see [clip] warnings above for cause)`,
      );
    }

    // ---- Merge (lossless stream-copy) --------------------------------------
    jobStore.update(jobId, { progress: 84, message: "Merging clips" });
    const mergedPath = path.join(config.dirs.temp, `merged_${jobId}.mp4`);
    scope.track(mergedPath);
    await mergeClips(clipPaths, mergedPath);

    // Clips are no longer needed — free the disk before the music pass.
    await remove(clipPaths);
    clipPaths.forEach((c) => scope.untrack(c));

    // ---- Background music (audio-only re-encode) ---------------------------
    const finalPath = path.join(config.dirs.output, `${jobId}_final.mp4`);
    const bg = options.audio?.backgroundMusic;
    let musicApplied = false;

    if (bg?.enabled && (bg.track || options.uploadedMusicPath)) {
      jobStore.update(jobId, { progress: 90, message: "Mixing background music" });
      try {
        const mixed = await mixBackgroundMusic({
          videoPath: mergedPath,
          outPath: finalPath,
          music: bg,
          totalDuration,
          uploadedTrackPath: options.uploadedMusicPath,
        });
        musicApplied = Boolean(mixed);
      } catch (err) {
        logger.warn("music", `mix failed, delivering without music: ${err.message.split("\n")[0]}`);
      }
    }

    if (!musicApplied) {
      await fs.promises.rename(mergedPath, finalPath).catch(async () => {
        await fs.promises.copyFile(mergedPath, finalPath);
      });
      scope.untrack(mergedPath);
    }

    const url = `${host}/output/${jobId}_final.mp4`;
    const elapsed = (Date.now() - started) / 1000;

    jobStore.update(jobId, {
      status: "done",
      progress: 100,
      message: skipped > 0 ? `Done — ${skipped}/${panels.length} panel(s) failed and were skipped` : "Done",
      url,
      videoUrl: url,
      video_url: url,
      download_url: url,
      panels: panels.length,
      rendered: clipPaths.length,
      skipped,
      warning: skipped > 0 ? `${skipped} of ${panels.length} panels failed to encode and are missing from the final video.` : null,
      renderer: config.rendererName,
      format: "MP4 (H.264 + AAC)",
      device_support: "Universal (iOS, Android, Chrome, Safari, Edge)",
      fps,
      resolution: `${width}x${height}`,
      aspectMode: options.aspectMode,
      backgroundMusic: musicApplied,
      audio: {
        processing: options.audio.enabled,
        speed: options.audio.speed,
        targetLUFS: options.audio.targetLUFS,
        normalize: options.audio.normalize,
        voiceEnhancement: options.audio.voiceEnhancement,
      },
      renderSeconds: Number(elapsed.toFixed(1)),
      encodingSettings: { crf: options.crf, preset: options.preset, concat: "stream-copy" },
      ...meta,
    });

    logger.info("render", `${jobId} complete in ${elapsed.toFixed(1)}s → ${url}`);
  } catch (err) {
    logger.error("render", `${jobId} failed: ${err.message.split("\n")[0]}`);
    jobStore.update(jobId, { status: "error", error: err.message, message: "Render failed" });
  } finally {
    await scope.dispose();
  }
}

module.exports = { renderPanels, resolveDurations, randomId };
