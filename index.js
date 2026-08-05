const express = require("express");
const multer = require("multer");
const cors = require("cors");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execSync, spawn } = require("child_process");
const AdmZip = require("adm-zip");

const app = express();
const PORT = process.env.PORT || 8080;
const RENDERER_NAME = process.env.RENDERER_NAME || "renderer";

// ================================
// FFmpeg Detection & Validation
// ================================

function validateFFmpegInstallation() {
  const possiblePaths = [
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/ffmpeg/bin/ffmpeg",
    "ffmpeg"
  ];

  let foundPath = null;
  for (const ffmpegPath of possiblePaths) {
    try {
      const result = execSync(`${ffmpegPath} -version 2>&1`, { encoding: "utf-8" });
      if (result.includes("ffmpeg version")) {
        foundPath = ffmpegPath;
        console.log(`✓ FFmpeg found at: ${ffmpegPath}`);
        break;
      }
    } catch (e) {
      continue;
    }
  }

  if (!foundPath) {
    console.error("❌ CRITICAL: FFmpeg is NOT installed!");
    process.exit(1);
  }

  return foundPath;
}

const FFMPEG_PATH = validateFFmpegInstallation();
const FFPROBE_PATH = FFMPEG_PATH.replace("ffmpeg", "ffprobe");

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

console.log(`✓ FFmpeg Path: ${FFMPEG_PATH}`);
console.log(`✓ FFprobe Path: ${FFPROBE_PATH}`);

// ================================
// Middleware
// ================================

app.use(cors());

// FIX #2: Increase Request Limits
app.use(express.json({ limit: "2gb" }));
app.use(express.urlencoded({ extended: true, limit: "2gb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(path.join(__dirname, "output")));
app.use("/music-files", express.static(process.env.MUSIC_DIR || path.join(__dirname, "music")));

app.use((req, _res, next) => {
  console.log(`${req.method} ${req.originalUrl}`);
  next();
});

// ================================
// No Token Authentication (Development/Testing)
// ================================

app.use((req, res, next) => {
  next();
});

// ================================
// Directories
// ================================

const UPLOADS_ROOT = path.join(__dirname, "uploads");
const OUTPUT_ROOT  = path.join(__dirname, "output");
const TEMP_ROOT    = path.join(__dirname, "temp");
// PERSISTENT background-music library. Never touched by the auto-cleanup job,
// so uploaded tracks stay available until the app itself is deleted.
const MUSIC_ROOT   = process.env.MUSIC_DIR || path.join(__dirname, "music");

[UPLOADS_ROOT, OUTPUT_ROOT, TEMP_ROOT, MUSIC_ROOT].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// ================================
// In-Memory Job Store
// ================================

const jobs = {};

function createJob() {
  const jobId = crypto.randomBytes(8).toString("hex");
  jobs[jobId] = {
    status: "queued",
    progress: 0,
    url: null,
    error: null,
    createdAt: new Date()
  };
  return jobId;
}

function updateJob(jobId, patch) {
  if (jobs[jobId]) Object.assign(jobs[jobId], patch);
}

function scheduleJobEviction(jobId) {
  setTimeout(() => { delete jobs[jobId]; }, 3 * 60 * 60 * 1000);
}

// ================================
// Helpers
// ================================

function safeName(value, fallback) {
  const raw = String(value || fallback || "").trim();
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || fallback;
}

function extFor(file, fallback) {
  const original = file?.originalname ? path.extname(file.originalname) : "";
  if (original) return original.toLowerCase();

  const mime = (file?.mimetype || "").toLowerCase();
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("png"))  return ".png";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("wav"))  return ".wav";
  if (mime.includes("mpeg")) return ".mp3";
  if (mime.includes("mp3"))  return ".mp3";
  if (mime.includes("mp4"))  return ".mp4";
  return fallback;
}

function wrapText(text, maxW = 44) {
  if (!text || !text.trim()) return "";

  const words = text.trim().split(/\s+/);
  const lines = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxW) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word.slice(0, maxW);
    }
  }

  if (line) lines.push(line);
  return lines.slice(0, 3).join("\n");
}

function cleanupFiles(files = []) {
  files.forEach((file) => {
    try { fs.unlinkSync(file); } catch (_) {}
  });
}

// ================================
// Get Audio Duration (with fallback)
// ================================

function getAudioDuration(audioPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(audioPath)) {
      return resolve({ valid: false, reason: "Audio file does not exist" });
    }

    ffmpeg.ffprobe(audioPath, (err, data) => {
      if (err) {
        return resolve({ valid: false, reason: `ffprobe error: ${err.message}` });
      }

      const audioStream = data.streams?.find(s => s.codec_type === "audio");
      if (!audioStream) {
        return resolve({ valid: false, reason: "No audio stream found" });
      }

      const duration = parseFloat(
        audioStream.duration ||
        data.format?.duration ||
        0
      );

      if (!duration || duration <= 0) {
        return resolve({ valid: false, reason: "Invalid audio duration" });
      }

      resolve({ valid: true, duration });
    });
  });
}

// ================================
// Get Image Dimensions
// ================================

function getImageDimensions(imagePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(imagePath)) {
      return resolve({ valid: false, reason: "Image file does not exist" });
    }

    ffmpeg.ffprobe(imagePath, (err, data) => {
      if (err) {
        return resolve({ valid: false, reason: `ffprobe error: ${err.message}` });
      }

      const videoStream = data.streams?.find(s => s.codec_type === "video");
      if (!videoStream) {
        return resolve({ valid: false, reason: "No image stream found" });
      }

      const width = videoStream.width || 0;
      const height = videoStream.height || 0;

      if (!width || !height) {
        return resolve({ valid: false, reason: "Could not determine image dimensions" });
      }

      const aspectRatio = width / height;
      resolve({
        valid: true,
        width,
        height,
        aspectRatio
      });
    });
  });
}

// ================================
// Calculate Panel Duration (with priority order)
// ================================

async function calculatePanelDuration(panel) {
  const PADDING = 0.2;

  // Priority 1: ZIP MP3 audio (actual duration)
  if (panel.audio && panel.audio_source === "zip") {
    const audioPath = path.join(panel.dir, panel.audio);
    const result = await getAudioDuration(audioPath);
    if (result.valid) {
      const duration = result.duration + PADDING;
      console.log(`[panel ${panel.index + 1}] ${panel.audio} → ${result.duration.toFixed(1)} sec + ${PADDING} sec padding = ${duration.toFixed(1)} sec`);
      return duration;
    } else {
      throw new Error(`Panel ${panel.index + 1} audio corrupted: ${result.reason}`);
    }
  }

  // Priority 2: Edge TTS duration (from metadata)
  if (panel.tts_duration && panel.tts_provider === "edge") {
    const duration = panel.tts_duration + PADDING;
    console.log(`[panel ${panel.index + 1}] Edge TTS → ${panel.tts_duration.toFixed(1)} sec + ${PADDING} sec padding = ${duration.toFixed(1)} sec`);
    return duration;
  }

  // Priority 3: gTTS duration (from metadata)
  if (panel.tts_duration && panel.tts_provider === "gtts") {
    const duration = panel.tts_duration + PADDING;
    console.log(`[panel ${panel.index + 1}] gTTS → ${panel.tts_duration.toFixed(1)} sec + ${PADDING} sec padding = ${duration.toFixed(1)} sec`);
    return duration;
  }

  // Priority 4: Narration text fallback
  if (panel.narration) {
    const wordCount = String(panel.narration).split(/\s+/).filter(Boolean).length;
    const duration = Math.max(3, Math.min(12, Math.round(wordCount / 2.3) + 1));
    console.log(`[panel ${panel.index + 1}] narration (${wordCount} words) → ${duration} sec`);
    return duration;
  }

  // Priority 5: Default
  console.log(`[panel ${panel.index + 1}] no audio/narration → default 4 sec`);
  return 4;
}

// ================================
// Validate Segment
// ================================

function validateSegment(segPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(segPath)) {
      return resolve({ valid: false, reason: "File does not exist" });
    }

    ffmpeg.ffprobe(segPath, (err, data) => {
      if (err) {
        return resolve({ valid: false, reason: `ffprobe error: ${err.message}` });
      }

      const hasVideo = data.streams?.some(s => s.codec_type === "video");
      const hasAudio = data.streams?.some(s => s.codec_type === "audio");

      if (!hasVideo) {
        return resolve({ valid: false, reason: "No video stream found" });
      }

      if (!hasAudio) {
        return resolve({ valid: false, reason: "No audio stream found" });
      }

      resolve({ valid: true, data });
    });
  });
}

// ================================
// Multer - FIX #1: Use diskStorage instead of memoryStorage
// ================================

// FIX #1: Panel upload now uses diskStorage for better memory handling
const panelDiskStorage = multer.diskStorage({
  destination: UPLOADS_ROOT,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `panel_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
  }
});

const panelUpload = multer({
  storage: panelDiskStorage,
  limits: { fileSize: 500 * 1024 * 1024, files: 4 }
});

const diskStorage = multer.diskStorage({
  destination: UPLOADS_ROOT,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
  }
});

// FIX: Increased fileSize limit from 2MB to 300MB to support larger uploads
const diskUpload = multer({
  storage: diskStorage,
  limits: {
    fileSize: 300 * 1024 * 1024,  // 300MB per file (was 2MB)
    files: 3000                    // up to 3000 files
  }
});

// FIX #1: Audio ZIP upload now uses diskStorage instead of memoryStorage
const zipDiskStorage = multer.diskStorage({
  destination: TEMP_ROOT,
  filename: (_req, file, cb) => {
    cb(null, `audio_zip_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.zip`);
  }
});

const zipUpload = multer({
  storage: zipDiskStorage,
  limits: { fileSize: 500 * 1024 * 1024, files: 1 }
});

// ================================
// FPS: Fixed at 15 — cinematic anime/manhua feeling, much faster render
// ================================

function getFps(panelCount) {
  // 15fps: more visible motion per frame, anime/manhua style, ~40% faster encode
  return 15;
}

// ================================
// ENHANCEMENT: Aspect Ratio Helper
// ================================

function calculateFitInFrame(imageAspectRatio, frameWidth = 1280, frameHeight = 720) {
  const frameAspect = frameWidth / frameHeight;
  
  let scaledWidth, scaledHeight;
  
  if (imageAspectRatio > frameAspect) {
    // Image is wider than frame
    scaledWidth = frameWidth;
    scaledHeight = Math.round(frameWidth / imageAspectRatio);
  } else {
    // Image is taller than frame
    scaledHeight = frameHeight;
    scaledWidth = Math.round(frameHeight * imageAspectRatio);
  }
  
  const offsetX = Math.round((frameWidth - scaledWidth) / 2);
  const offsetY = Math.round((frameHeight - scaledHeight) / 2);
  
  return { scaledWidth, scaledHeight, offsetX, offsetY };
}

// ================================
// Ken Burns Animation — cinematic zoom in/out + slide left/right/up/down
// 15fps · scale=2560 · zoom=1.18 · movement 10%–18% for alive anime feel
// ================================

function getKenBurnsFilter(idx, duration, panelCount = 1, aspectMode = "fit") {
  const fps = 15; // Always 15fps
  const totalFrames = Math.ceil(duration * fps);
  const normalised = String(aspectMode || "fit").toLowerCase().trim();

  if (normalised === "fit") {
    // FIT MODE — full image visible, letterbox/pillarbox, strong Ken Burns
    const animations = [
      // 1. Zoom IN (100% → 118%)
      `scale=2560:-1,zoompan=z='min(zoom+0.0009,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
      // 2. Zoom OUT (118% → 100%)
      `scale=2560:-1,zoompan=z='if(lte(on,1),1.18,max(zoom-0.0009,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
      // 3. Slide LEFT (pan 10% → 18%)
      `scale=2560:-1,zoompan=z='1.18':x='if(lte(on,1),iw*0.10,min(x+iw*0.08/${totalFrames},iw*0.18))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
      // 4. Slide RIGHT (pan 18% → 10%)
      `scale=2560:-1,zoompan=z='1.18':x='if(lte(on,1),iw*0.18,max(x-iw*0.08/${totalFrames},iw*0.10))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
      // 5. Slide UP (pan 8% → 16% vertical)
      `scale=2560:-1,zoompan=z='1.18':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.08,min(y+ih*0.08/${totalFrames},ih*0.16))':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
      // 6. Slide DOWN (pan 16% → 8% vertical)
      `scale=2560:-1,zoompan=z='1.18':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.16,max(y-ih*0.08/${totalFrames},ih*0.08))':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
    ];
    return animations[idx % animations.length];

  } else if (normalised === "cinematic") {
    // CINEMATIC MODE — fill full frame, stronger zoom and movement
    const animations = [
      // 1. Zoom IN center
      `scale=2560:-1,zoompan=z='min(zoom+0.0009,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,setsar=1`,
      // 2. Zoom OUT center
      `scale=2560:-1,zoompan=z='if(lte(on,1),1.18,max(zoom-0.0009,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,setsar=1`,
      // 3. Slide LEFT
      `scale=2560:-1,zoompan=z='1.18':x='if(lte(on,1),iw*0.10,min(x+iw*0.08/${totalFrames},iw*0.18))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,setsar=1`,
      // 4. Slide RIGHT
      `scale=2560:-1,zoompan=z='1.18':x='if(lte(on,1),iw*0.18,max(x-iw*0.08/${totalFrames},iw*0.10))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,setsar=1`,
      // 5. Slide UP
      `scale=2560:-1,zoompan=z='1.18':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.08,min(y+ih*0.08/${totalFrames},ih*0.16))':d=${totalFrames}:s=1280x720:fps=15,setsar=1`,
      // 6. Slide DOWN
      `scale=2560:-1,zoompan=z='1.18':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.16,max(y-ih*0.08/${totalFrames},ih*0.08))':d=${totalFrames}:s=1280x720:fps=15,setsar=1`,
    ];
    return animations[idx % animations.length];
  }

  if (normalised === "blurpad" || normalised === "blur-pad" || normalised === "blur_pad") {
    // BLUR-PAD MODE — original image centred at native ratio over a heavily
    // blurred, scaled copy of itself. No distortion, no black bars.
    // Ken Burns is applied to the foreground only; the blurred bg is static.
    const animations = [
      // 1. Zoom IN foreground
      `split[bg][fg];[bg]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,gblur=sigma=22,eq=brightness=-0.05[bg2];[fg]scale=2560:-1,zoompan=z='min(zoom+0.0009,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1`,
      // 2. Zoom OUT foreground
      `split[bg][fg];[bg]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,gblur=sigma=22,eq=brightness=-0.05[bg2];[fg]scale=2560:-1,zoompan=z='if(lte(on,1),1.18,max(zoom-0.0009,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1`,
      // 3. Slide LEFT
      `split[bg][fg];[bg]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,gblur=sigma=22,eq=brightness=-0.05[bg2];[fg]scale=2560:-1,zoompan=z='1.12':x='if(lte(on,1),iw*0.10,min(x+iw*0.06/${totalFrames},iw*0.16))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1`,
      // 4. Slide RIGHT
      `split[bg][fg];[bg]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,gblur=sigma=22,eq=brightness=-0.05[bg2];[fg]scale=2560:-1,zoompan=z='1.12':x='if(lte(on,1),iw*0.16,max(x-iw*0.06/${totalFrames},iw*0.10))':y='ih/2-(ih/zoom/2)':d=${totalFrames}:s=1280x720:fps=15,scale=1280:720:force_original_aspect_ratio=decrease[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1`,
    ];
    return animations[idx % animations.length];
  }

  // Default: static fit (fastest, no animation)
  return `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
}

// ================================
// ENHANCEMENT 1: Build FFmpeg audio filter chain with smooth normalization
// ================================

function buildAudioFilterChain(options = {}) {
  const filters = [];
  
  // Audio normalization for consistent loudness
  if (options.audioNormalize || options.loudnorm) {
    filters.push("loudnorm=I=-16:TP=-1.5:LRA=11");
  }
  
  // Optional: Add gentle compression for smooth transitions
  if (options.smoothAudio) {
    filters.push("acompressor=threshold=0.05:ratio=4:attack=5:release=50");
  }
  
  return filters.length ? filters.join(",") : "";
}

// ================================
// ENHANCEMENT 2: Build FFmpeg video filter chain with quality optimization
// ================================

function buildVideoFilterChain(options = {}, baseFilter = "") {
  const filters = [baseFilter];
  
  // Optional zoom/crop adjustments (subtle, not aggressive)
  if (options.zoom || options.zoomFactor || options.cropX || options.cropY) {
    const zoomFactor = parseFloat(options.zoomFactor || options.zoom || 1.0);
    if (zoomFactor > 1.0 && zoomFactor <= 3.0) {
      const fx = Math.max(0, Math.min(1, parseFloat(options.focusX || 0.5)));
      const fy = Math.max(0, Math.min(1, parseFloat(options.focusY || 0.5)));
      const cw = Math.round(1280 / zoomFactor);
      const ch = Math.round(720  / zoomFactor);
      const cx = Math.round((1280 - cw) * fx);
      const cy = Math.round((720  - ch) * fy);
      filters.push(`crop=${cw}:${ch}:${cx}:${cy},scale=1280:720`);
    }
  }
  
  return filters.join(",");
}

// ================================
// Create Segment (MP4) - OPTIMIZED for quality & speed
// ================================

function createSegment({ imagePath, audioPath, text, duration, outPath, jobId, idx, panelCount, aspectMode, renderOptions = {} }) {
  return new Promise((resolve, reject) => {
    const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    const wrapped = wrapText(text);
    const kenBurns = getKenBurnsFilter(idx, duration, panelCount, aspectMode);

    const vfParts = [
      buildVideoFilterChain(renderOptions, kenBurns),
      "setsar=1"
    ];

    const hasAudio = audioPath && fs.existsSync(audioPath);
    const overlayPath = renderOptions.overlayPath && fs.existsSync(renderOptions.overlayPath)
      ? renderOptions.overlayPath : null;
    const overlayMeta = renderOptions.overlay || null;

    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`[${RENDERER_NAME}][seg${idx}] START — jobId=${jobId} mode=${aspectMode} dur=${duration}s panelCount=${panelCount} mem=${memMB}MB`);

    const cmd = ffmpeg()
      .setFfmpegPath(FFMPEG_PATH)
      .input(imagePath)
      .inputOptions(["-loop 1", "-framerate 15"]);

    if (hasAudio) {
      cmd.input(audioPath);
    } else {
      cmd
        .input(`aevalsrc=0:channel_layout=stereo:sample_rate=44100:duration=${duration}`)
        .inputOptions(["-f lavfi"]);
    }

    // Optional channel branding overlay (PNG with alpha)
    if (overlayPath) {
      cmd.input(overlayPath);
    }

    // Speed-optimised quality settings
    const videoCodec   = renderOptions.videoCodec  || "libx264";
    const pixFmt       = renderOptions.pixFmt       || "yuv420p";
    const crf          = Math.max(18, Math.min(26, parseInt(renderOptions.crf) || 21)); // CRF 21
    const preset       = renderOptions.preset        || "faster"; // faster > medium for speed
    const maxrate      = renderOptions.maxrate        || "";
    const bufsize      = renderOptions.bufsize        || "";
    const audioBitrate = renderOptions.audioBitrate   || "192k";
    const movflags     = renderOptions.movflags ? String(renderOptions.movflags) : "+faststart";

    // No loudnorm — removed for speed; audio passed through clean
    // Build the video filter pipeline. If an overlay is attached, switch
    // from -vf to -filter_complex so we can composite the watermark.
    let videoFilterFlag = ["-vf", vfParts.join(",")];
    if (overlayPath) {
      const pos = overlayMeta?.position || "top-right";
      const sizePct = Math.max(3, Math.min(40, Number(overlayMeta?.sizePct ?? 12)));
      const margin  = Math.max(0, Math.min(200, Number(overlayMeta?.marginPx ?? 16)));
      const opacity = Math.max(0.05, Math.min(1, Number(overlayMeta?.opacity ?? 1)));
      const wmW = Math.round(1280 * sizePct / 100);

      let xExpr, yExpr;
      if (pos === "top-left")          { xExpr = String(margin);                 yExpr = String(margin); }
      else if (pos === "bottom-left")  { xExpr = String(margin);                 yExpr = `H-h-${margin}`; }
      else if (pos === "bottom-right") { xExpr = `W-w-${margin}`;              yExpr = `H-h-${margin}`; }
      else                              { xExpr = `W-w-${margin}`;              yExpr = String(margin); }

      const complex =
        `[0:v]${vfParts.join(",")}[bgv];` +
        `[2:v]scale=${wmW}:-1,format=rgba,colorchannelmixer=aa=${opacity}[wm];` +
        `[bgv][wm]overlay=${xExpr}:${yExpr}:format=auto[outv]`;
      videoFilterFlag = ["-filter_complex", complex, "-map", "[outv]", "-map", "1:a?"];
    }

    // Force every panel audio stream to start at timestamp zero and have the
    // exact same duration as its image segment. This prevents cumulative AAC
    // encoder-delay / timestamp drift when many panel clips are joined.
    const exactAudioFilter = `aresample=44100:async=1:first_pts=0,apad,atrim=0:${Number(duration).toFixed(3)},asetpts=N/SR/TB`;

    const outputOpts = [
      ...videoFilterFlag,
      `-c:v ${videoCodec}`,
      `-pix_fmt ${pixFmt}`,
      `-r 15`,           // ← 15 fps output
      `-g 30`,           // ← GOP = 2× fps for clean seeking
      `-crf ${crf}`,
      `-preset ${preset}`,
      `-threads 0`,      // ← Let FFmpeg use all available CPU cores
      `-movflags ${movflags}`,
      `-af ${exactAudioFilter}`,
      `-c:a aac`,
      `-b:a ${audioBitrate}`,
      `-t ${Number(duration).toFixed(3)}`
    ];

    // Add bitrate control if specified
    if (maxrate) outputOpts.splice(-3, 0, `-maxrate ${maxrate}`);
    if (bufsize)  outputOpts.splice(-3, 0, `-bufsize ${bufsize}`);

    cmd
      .outputOptions(outputOpts)
      .output(outPath)
      .on("start", () => {
        console.log(`[seg${idx}] FFmpeg encoding started`);
      })
      .on("progress", () => {
        // suppress per-frame logs
      })
      .on("end", () => {
        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        console.log(`[seg${idx}] END — mem=${memMB}MB`);
        resolve();
      })
      .on("error", (err) => {
        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const isOOM = err.message.includes("Cannot allocate memory") ||
                      err.message.includes("Out of memory") ||
                      err.message.includes("ENOMEM") ||
                      err.message.includes("killed");
        if (isOOM) {
          console.error(`[seg${idx}] ❌ OOM CRASH — mem=${memMB}MB — ${err.message}`);
        } else {
          console.error(`[seg${idx}] ❌ ERROR — mem=${memMB}MB — ${err.message}`);
        }
        reject(err);
      })
      .run();
  });
}

// ================================
// createSegment with retry + skip on failure
// ================================

async function createSegmentSafe({ imagePath, audioPath, text, duration, outPath, jobId, idx, panelCount, aspectMode, renderOptions = {} }) {
  const MAX_RETRIES = 2;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await createSegment({ imagePath, audioPath, text, duration, outPath, jobId, idx, panelCount, aspectMode, renderOptions });
      return { success: true };
    } catch (err) {
      lastErr = err;
      const isOOM = err.message.includes("Cannot allocate memory") ||
                    err.message.includes("Out of memory") ||
                    err.message.includes("ENOMEM") ||
                    err.message.includes("killed");
      console.warn(`[seg${idx}] attempt ${attempt}/${MAX_RETRIES} failed${isOOM ? " (OOM)" : ""}: ${err.message.split("\n")[0]}`);
      if (isOOM) {
        await new Promise(r => setTimeout(r, 3000 * attempt));
      }
    }
  }

  console.error(`[seg${idx}] ❌ ALL RETRIES FAILED — skipping panel. Last error: ${lastErr.message.split("\n")[0]}`);
  return { success: false, error: lastErr.message };
}

// ================================
// SPAWN FFmpeg Helper
// ================================

function spawnFfmpeg(args, description = "") {
  return new Promise((resolve, reject) => {
    console.log(`[ffmpeg] Running: ffmpeg ${args.join(" ")}`);
    const proc = spawn(FFMPEG_PATH, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
      console.log(`[ffmpeg] stderr: ${data}`);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        console.log(`[ffmpeg] ✓ ${description || "Command"} succeeded`);
        resolve({ success: true, stdout, stderr });
      } else {
        const isOOM = stderr.includes("Cannot allocate memory") ||
                      stderr.includes("Out of memory") ||
                      stderr.includes("ENOMEM") ||
                      code === 137;
        const label = isOOM ? "❌ OOM KILL" : "✗";
        const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const err = new Error(`FFmpeg ${isOOM ? "OOM" : `failed (code ${code})`}: ${description} — mem=${memMB}MB\n${stderr.slice(-800)}`);
        console.error(`[ffmpeg] ${label} ${description} code=${code} mem=${memMB}MB`);
        reject(err);
      }
    });

    proc.on("error", (err) => {
      console.error(`[ffmpeg] spawn error:`, err.message);
      reject(err);
    });
  });
}

// ================================
// CONCAT — Lossless stream-copy (no re-render, no quality loss, instant)
// Segments already encoded at 15fps/CRF-21; just join them.
// ================================

async function concatWithTransitions(segPaths, durations, outPath, renderOptions = {}) {
  const n = segPaths.length;
  const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`\n[concat] START (stream-copy, no re-render) — ${n} segments — mem=${memMB}MB`);

  if (!n) throw new Error("No segments to concat");

  // Single segment: just copy
  if (n === 1) {
    console.log("[concat] Single segment — copying directly");
    fs.copyFileSync(segPaths[0], outPath);
    return;
  }

  // Verify all segments exist
  for (let i = 0; i < n; i++) {
    if (!fs.existsSync(segPaths[i])) {
      throw new Error(`Segment ${i} missing: ${segPaths[i]}`);
    }
  }

  // Write concat list file
  const concatFile = path.join(TEMP_ROOT, `concat_${Date.now()}.txt`);
  fs.writeFileSync(concatFile, segPaths.map(s => `file '${s}'`).join("\n"), "utf8");

  // Keep the video lossless, but rebuild the joined AAC stream. Concatenating
  // independently encoded AAC streams with `-c copy` preserves encoder priming
  // and timestamp discontinuities at every panel boundary, which causes the
  // narration to drift away from the images over time.
  const args = [
    "-fflags", "+genpts",
    "-f",      "concat",
    "-safe",   "0",
    "-i",      concatFile,
    "-map",    "0:v:0",
    "-map",    "0:a:0",
    "-c:v",    "copy",
    "-af",     "aresample=44100:async=1:first_pts=0,asetpts=N/SR/TB",
    "-c:a",    "aac",
    "-b:a",    "192k",
    "-ar",     "44100",
    "-ac",     "2",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    "-y",
    outPath
  ];

  console.log("[concat] Joining video losslessly and rebuilding continuous audio timestamps...");
  try {
    await spawnFfmpeg(args, "timestamp-safe concat");
    console.log(`[concat] ✓ timestamp-safe concat succeeded`);
  } finally {
    try { fs.unlinkSync(concatFile); } catch (_) {}
  }

  const memAfterMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  console.log(`[concat] END — mem=${memAfterMB}MB → ${outPath}`);
}

// ================================
// VALIDATION - Check all panels before render
// ================================

async function validateRenderPanels(panels) {
  const errors = [];

  for (let i = 0; i < panels.length; i++) {
    const p = panels[i];
    const panelNum = i + 1;

    if (!p.image || !fs.existsSync(path.join(p.dir, p.image))) {
      errors.push(`Panel ${panelNum} image missing`);
      continue;
    }

    console.log(`[validate] ✓ Panel ${panelNum} image valid`);

    if (p.audio) {
      const audioPath = path.join(p.dir, p.audio);
      if (!fs.existsSync(audioPath)) {
        errors.push(`Panel ${panelNum} missing audio`);
        continue;
      }

      const result = await getAudioDuration(audioPath);
      if (!result.valid) {
        errors.push(`Panel ${panelNum} audio corrupted: ${result.reason}`);
        continue;
      }

      console.log(`[validate] ✓ Panel ${panelNum} audio valid (${result.duration.toFixed(1)} sec)`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Render validation failed:\n${errors.join("\n")}`);
  }

  console.log(`[validate] ✓ All ${panels.length} panels validated successfully`);
}

// ================================
// HEALTH CHECK
// ================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    renderer: RENDERER_NAME,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    timestamp: new Date().toISOString()
  });
});

// ================================
// STATUS ROUTE
// ================================

app.get("/status/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) {
    return res.status(404).json({ success: false, error: "Job not found" });
  }
  res.json({ success: true, ...job });
});

// ================================
// PANEL UPLOAD ROUTE
// ================================

app.post(
  "/panel",
  panelUpload.fields([
    { name: "image", maxCount: 1 },
    { name: "audio", maxCount: 1 }
  ]),
  (req, res) => {
    try {
      const projectId = safeName(req.body.project_id || req.body.projectId, "project");
      const panelId   = safeName(req.body.panel_id || req.body.panelId || `panel_${Date.now()}`, "panel");
      const duration  = Number(req.body.duration || 4);
      const narration = String(req.body.narration || "").trim();

      if (!req.files?.image || !req.files.image[0]) {
        return res.status(400).json({ success: false, error: "Image required" });
      }

      const projectDir = path.join(UPLOADS_ROOT, projectId);
      const panelDir   = path.join(projectDir, panelId);

      [projectDir, panelDir].forEach((dir) => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      });

      // FIX #1: Read from disk instead of buffer
      const imageBuffer = fs.readFileSync(req.files.image[0].path);
      const imagePath = path.join(panelDir, `image.jpg`);
      fs.writeFileSync(imagePath, imageBuffer);
      fs.unlinkSync(req.files.image[0].path); // Clean up temp file

      let audioPath = null;
      let audioFileName = null;
      if (req.files?.audio && req.files.audio[0]) {
        const audioExt = extFor(req.files.audio[0], ".mp3");
        audioFileName = `audio${audioExt}`;
        audioPath = path.join(panelDir, audioFileName);
        const audioBuffer = fs.readFileSync(req.files.audio[0].path);
        fs.writeFileSync(audioPath, audioBuffer);
        fs.unlinkSync(req.files.audio[0].path); // Clean up temp file
      }

      const index = Number(req.body.index || 0);

      // Per-panel manual zoom/crop (frontend sends 0-100 % focus or 0-1)
      const zoomVal = Math.max(1, Math.min(3, Number(req.body.zoom || req.body.zoomFactor || 1)));
      const rawFX = Number(req.body.focusX != null ? req.body.focusX : req.body.cropX);
      const rawFY = Number(req.body.focusY != null ? req.body.focusY : req.body.cropY);
      const focusX = Number.isFinite(rawFX) ? (rawFX > 1 ? rawFX / 100 : rawFX) : 0.5;
      const focusY = Number.isFinite(rawFY) ? (rawFY > 1 ? rawFY / 100 : rawFY) : 0.5;

      fs.writeFileSync(
        path.join(panelDir, "metadata.json"),
        JSON.stringify({
          index,
          duration,
          narration,
          image:       "image.jpg",
          audio:       audioFileName,
          zoom:        zoomVal,
          focusX,
          focusY,
          uploaded_at: new Date().toISOString()
        }, null, 2)
      );

      console.log(`[panel] saved ${projectId}/${panelId}`);

      return res.json({
        success:    true,
        panel:      panelId,
        panel_id:   panelId,
        ref:        panelId,
        project_id: projectId
      });

    } catch (err) {
      console.error("/panel error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// ================================
// AUDIO ZIP UPLOAD ROUTE
// ================================

app.post("/audio-zip", zipUpload.single("audioZip"), async (req, res) => {
  try {
    const projectId = safeName(req.body.project_id || req.body.projectId, "");
    if (!projectId) {
      return res.status(400).json({ success: false, error: "Missing project_id" });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, error: "audioZip file required" });
    }

    const projectDir = path.join(UPLOADS_ROOT, projectId);
    if (!fs.existsSync(projectDir)) {
      return res.status(404).json({ success: false, error: "Project not found. Upload panels first." });
    }

    // FIX #1: Read from disk instead of memory buffer
    const zipBuffer = fs.readFileSync(req.file.path);
    const zip = new AdmZip(zipBuffer);
    fs.unlinkSync(req.file.path); // Clean up temp file
    
    const entries = zip.getEntries();

    const mp3Entries = entries
      .filter(e => !e.isDirectory)
      .filter(e => {
        const name = e.entryName.replace(/\\/g, "/");
        if (name.includes("__MACOSX")) return false;
        if (path.basename(name).startsWith(".")) return false;
        return /\.mp3$/i.test(name);
      })
      .map(e => {
        const base = path.basename(e.entryName);
        const match = base.match(/(\d+)/);
        return match ? { entry: e, num: Number(match[1]), file: base } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.num - b.num);

    if (!mp3Entries.length) {
      return res.status(400).json({
        success: false,
        error: "No valid numbered MP3 found. Use 1.mp3, 2.mp3, 3.mp3, audio_1.mp3, panel_1.mp3, etc."
      });
    }

    const panelFolders = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .map(name => {
        const dir = path.join(projectDir, name);
        const metaPath = path.join(dir, "metadata.json");
        if (!fs.existsSync(metaPath)) return null;
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        return { name, dir, metaPath, meta };
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.meta.index || 0) - Number(b.meta.index || 0));

    const attached = [];
    const missing = [];

    for (let i = 0; i < panelFolders.length; i++) {
      const panelNumber = i + 1;
      const audio = mp3Entries.find(x => x.num === panelNumber);

      if (!audio) {
        missing.push(panelNumber);
        continue;
      }

      const panel = panelFolders[i];
      const outAudio = path.join(panel.dir, "audio.mp3");

      fs.writeFileSync(outAudio, audio.entry.getData());

      panel.meta.audio = "audio.mp3";
      panel.meta.audio_source = "zip";
      panel.meta.audio_original = audio.file;

      fs.writeFileSync(panel.metaPath, JSON.stringify(panel.meta, null, 2));

      attached.push({
        panel: panelNumber,
        image: panel.meta.image,
        audio: audio.file,
        status: "attached"
      });
    }

    return res.json({
      success: true,
      project_id: projectId,
      totalPanels: panelFolders.length,
      totalMp3Found: mp3Entries.length,
      attached,
      missing,
      message: missing.length
        ? `Attached ${attached.length} audio files. Missing audio for panels: ${missing.join(", ")}`
        : `All ${attached.length} MP3 files attached successfully.`
    });

  } catch (err) {
    console.error("/audio-zip error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================================
// BACKGROUND MUSIC LIBRARY (persistent)
// Tracks live in MUSIC_ROOT and are NEVER auto-deleted, so the
// library survives renders/restarts for the life of the app.
// ==========================================================

const AUDIO_EXT_RE = /\.(mp3|m4a|aac|wav|ogg|opus|flac)$/i;

const musicUpload = multer({
  storage: multer.diskStorage({
    destination: MUSIC_ROOT,
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || ".mp3").toLowerCase();
      const base = safeName(path.basename(file.originalname, path.extname(file.originalname)), "track");
      cb(null, `${base}_${Date.now().toString(36)}${ext}`);
    }
  }),
  limits: { fileSize: 100 * 1024 * 1024, files: 1 }
});

function listMusicTracks() {
  try {
    return fs.readdirSync(MUSIC_ROOT)
      .filter((f) => AUDIO_EXT_RE.test(f))
      .map((f) => {
        let size = 0;
        try { size = fs.statSync(path.join(MUSIC_ROOT, f)).size; } catch (_) {}
        return {
          id: f,
          name: path.basename(f, path.extname(f)).replace(/_[a-z0-9]{6,}$/i, "").replace(/[_-]+/g, " ").trim() || f,
          file: f,
          url: `/music-files/${encodeURIComponent(f)}`,
          sizeBytes: size,
          permanent: true
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (_) {
    return [];
  }
}

function resolveMusicTrack(trackId) {
  if (!trackId) return null;
  const wanted = String(trackId);
  const tracks = listMusicTracks();
  const hit =
    tracks.find((t) => t.id === wanted) ||
    tracks.find((t) => t.file === wanted) ||
    tracks.find((t) => t.name.toLowerCase() === wanted.toLowerCase()) ||
    tracks.find((t) => t.id.toLowerCase().startsWith(wanted.toLowerCase()));
  return hit ? path.join(MUSIC_ROOT, hit.file) : null;
}

// GET /music — list the permanent library
app.get("/music", (req, res) => {
  const tracks = listMusicTracks();
  res.json({ success: true, tracks, count: tracks.length, storage: "permanent" });
});

// POST /music — add a track to the permanent library
app.post("/music", musicUpload.single("music"), (req, res) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ success: false, error: "music file required" });
    if (!AUDIO_EXT_RE.test(f.filename)) {
      try { fs.unlinkSync(f.path); } catch (_) {}
      return res.status(400).json({ success: false, error: "Unsupported audio format" });
    }
    const track = listMusicTracks().find((t) => t.file === f.filename);
    console.log(`[music] saved permanent track: ${f.filename}`);
    return res.json({ success: true, track, ...track });
  } catch (err) {
    console.error("/music upload error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /music/:id — explicit removal only (never automatic)
app.delete("/music/:id", (req, res) => {
  const p = resolveMusicTrack(req.params.id);
  if (!p) return res.status(404).json({ success: false, error: "Track not found" });
  try {
    fs.unlinkSync(p);
    return res.json({ success: true, deleted: path.basename(p) });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Stream a single track (kept for frontends that request /music/:id directly)
app.get("/music/:id", (req, res) => {
  const p = resolveMusicTrack(req.params.id);
  if (!p) return res.status(404).json({ success: false, error: "Track not found" });
  res.sendFile(p);
});

// ==========================================================
// FINAL AUDIO PASS — voice normalization + background music mix
// Runs once on the concatenated video, so voice and music stay
// in sync and the loudness is consistent across the whole video.
// ==========================================================

function buildFinalAudioFilter({ totalDuration, voiceVolume, targetLUFS, normalize, enhance, hasMusic, musicVolume, crossfade, duck }) {
  const fadeLen = Math.max(0, Math.min(6, Number(crossfade) || 0));
  const voice = [];

  if (enhance) {
    voice.push("highpass=f=85", "lowpass=f=15000", "acompressor=threshold=0.06:ratio=3:attack=8:release=120");
  }
  if (normalize) {
    const I = Math.max(-24, Math.min(-9, Number(targetLUFS) || -16));
    voice.push(`loudnorm=I=${I}:TP=-1.5:LRA=11`);
  }
  voice.push(`volume=${Number(voiceVolume || 1).toFixed(3)}`);
  voice.push("aresample=44100", "aformat=sample_fmts=fltp:channel_layouts=stereo");

  if (!hasMusic) {
    return `[0:a]${voice.join(",")}[aout]`;
  }

  const music = [
    `volume=${Number(musicVolume || 0.15).toFixed(3)}`,
    "aresample=44100",
    "aformat=sample_fmts=fltp:channel_layouts=stereo",
    `atrim=0:${totalDuration.toFixed(3)}`
  ];
  if (fadeLen > 0) {
    music.push(`afade=t=in:st=0:d=${fadeLen}`);
    music.push(`afade=t=out:st=${Math.max(0, totalDuration - fadeLen).toFixed(3)}:d=${fadeLen}`);
  }

  const chain = [
    `[0:a]${voice.join(",")}[voice]`,
    `[1:a]${music.join(",")}[bed]`
  ];

  if (duck) {
    // Music automatically dips while narration plays.
    chain.push(`[voice]asplit=2[v1][vkey]`);
    chain.push(`[bed][vkey]sidechaincompress=threshold=0.2:ratio=2.5:attack=20:release=400:makeup=1[bedducked]`);
    chain.push(`[v1][bedducked]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.97[aout]`);
  } else {
    chain.push(`[voice][bed]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.97[aout]`);
  }

  return chain.join(";");
}

async function applyFinalAudio(inPath, outPath, totalDuration, renderOptions) {
  const audioOpts = renderOptions.audioChain || {};
  const musicOpts = renderOptions.musicChain || {};

  let musicPath = null;
  if (musicOpts.enabled) {
    musicPath = musicOpts.filePath && fs.existsSync(musicOpts.filePath)
      ? musicOpts.filePath
      : resolveMusicTrack(musicOpts.track);
    if (!musicPath) {
      const lib = listMusicTracks();
      if (lib.length) musicPath = path.join(MUSIC_ROOT, lib[0].file);
    }
    if (!musicPath) console.warn("[audio] Background music requested but no track available — skipping music.");
  }

  const hasMusic = Boolean(musicPath);
  const needsVoiceWork = audioOpts.normalize !== false || audioOpts.enhance || Number(audioOpts.voiceVolume || 1) !== 1;

  if (!hasMusic && !needsVoiceWork) {
    fs.copyFileSync(inPath, outPath);
    return { music: null };
  }

  const filter = buildFinalAudioFilter({
    totalDuration,
    voiceVolume: audioOpts.voiceVolume,
    targetLUFS: audioOpts.targetLUFS,
    normalize: audioOpts.normalize !== false,
    enhance: audioOpts.enhance,
    hasMusic,
    musicVolume: musicOpts.volume,
    crossfade: musicOpts.crossfade,
    duck: musicOpts.duck
  });

  const args = ["-i", inPath];
  if (hasMusic) {
    if (musicOpts.loop !== false) args.push("-stream_loop", "-1");
    args.push("-i", musicPath);
  }
  args.push(
    "-filter_complex", filter,
    "-map", "0:v",
    "-map", "[aout]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", renderOptions.audioBitrate || "192k",
    "-ar", "44100",
    "-ac", "2",
    "-t", totalDuration.toFixed(3),
    "-movflags", "+faststart",
    "-y", outPath
  );

  console.log(`[audio] Final pass — music=${hasMusic ? path.basename(musicPath) : "none"} vol=${musicOpts.volume} normalize=${audioOpts.normalize !== false}`);
  await spawnFfmpeg(args, "final audio pass (normalize + music mix)");
  return { music: hasMusic ? path.basename(musicPath) : null };
}

/** Mixes audio in place on the final MP4; falls back to the untouched file on error. */
async function finalizeAudio(finalPath, durations, renderOptions) {
  // Use the real muxed duration rather than the planned sum. Container/audio
  // rounding can differ by a few milliseconds per panel and accumulate.
  const probed = await new Promise((resolve) => {
    ffmpeg.ffprobe(finalPath, (err, data) => {
      if (err) return resolve(0);
      resolve(Number(data?.format?.duration || 0));
    });
  });
  const planned = durations.reduce((s, d) => s + Number(d || 0), 0);
  const total = probed > 0 ? probed : planned;
  if (!total) return { music: null };
  const tmpOut = path.join(TEMP_ROOT, `mix_${Date.now()}_${crypto.randomBytes(3).toString("hex")}.mp4`);
  try {
    const info = await applyFinalAudio(finalPath, tmpOut, total, renderOptions);
    fs.renameSync(tmpOut, finalPath);
    return info;
  } catch (err) {
    console.error(`[audio] Final audio pass failed — keeping original audio: ${err.message.split("\n")[0]}`);
    try { fs.unlinkSync(tmpOut); } catch (_) {}
    return { music: null, error: err.message.split("\n")[0] };
  }
}

// ================================
// RENDER ROUTE (async background job)
// ================================

// Multer for an optional overlay PNG attached to /render
const overlayUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_ROOT,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".png";
      cb(null, `overlay_${Date.now()}_${crypto.randomBytes(4).toString("hex")}${ext}`);
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 }
});

function handleRender(req, res) {
  // If a "payload" JSON field was sent alongside multipart, merge it into req.body
  if (req.body && typeof req.body.payload === "string") {
    try {
      const parsed = JSON.parse(req.body.payload);
      for (const k of Object.keys(parsed)) {
        if (req.body[k] == null) req.body[k] = parsed[k];
      }
    } catch (_) {}
  }
  // Stash overlay file path on req (if uploaded)
  if (req.files) {
    const f = req.files.overlay?.[0] || req.files.overlayLogo?.[0] || req.files.watermark?.[0];
    if (f) req._overlayPath = f.path;

    // Inline background-music upload: copied into the permanent library so it
    // stays available for every future render.
    const m = req.files.music?.[0] || req.files.musicFile?.[0];
    if (m) {
      try {
        const ext = (path.extname(m.originalname) || ".mp3").toLowerCase();
        const base = safeName(path.basename(m.originalname || "track", path.extname(m.originalname || "")), "track");
        const dest = path.join(MUSIC_ROOT, `${base}_${Date.now().toString(36)}${ext}`);
        fs.copyFileSync(m.path, dest);
        try { fs.unlinkSync(m.path); } catch (_) {}
        req._musicPath = dest;
        console.log(`[music] inline track stored permanently: ${path.basename(dest)}`);
      } catch (e) {
        req._musicPath = m.path;
        console.warn(`[music] could not persist inline track: ${e.message}`);
      }
    }
  }


  const hasProjectId = req.body?.project_id || req.body?.projectId;

  if (hasProjectId) {
    const jobId = createJob();
    res.json({ success: true, jobId, status: "queued" });

    setImmediate(() => {
      renderFromProject(req, jobId).catch((err) => {
        console.error(`[${jobId}] Unhandled project render error:`, err.message);
        updateJob(jobId, { status: "error", error: err.message });
        scheduleJobEviction(jobId);
      });
    });
    return;
  }

  // Images only — watermark/overlay removed for stability
  diskUpload.fields([
    { name: "images", maxCount: 2000 }
  ])(req, res, (multerErr) => {
    if (multerErr) {
      console.error("[/render] Multer error:", multerErr.message);
      return res.status(400).json({ success: false, error: multerErr.message });
    }

    const jobId = createJob();
    res.json({ success: true, jobId, status: "queued" });

    setImmediate(() => {
      renderFromMultipart(req, jobId).catch((err) => {
        console.error(`[${jobId}] Unhandled multipart render error:`, err.message);
        updateJob(jobId, { status: "error", error: err.message });
        scheduleJobEviction(jobId);
      });
    });
  });
}

// Accept /render as either:
//   - application/json                 -> handleRender directly
//   - multipart/form-data (overlay)    -> parse overlay+fields, then handleRender
app.post("/render", (req, res) => {
  const ct = String(req.headers["content-type"] || "");
  if (ct.includes("multipart/form-data")) {
    overlayUpload.fields([
      { name: "overlay",     maxCount: 1 },
      { name: "overlayLogo", maxCount: 1 },
      { name: "watermark",   maxCount: 1 },
      { name: "music",       maxCount: 1 },
      { name: "musicFile",   maxCount: 1 }
    ])(req, res, (err) => {
      if (err) {
        console.error("[/render] overlay multer error:", err.message);
        return res.status(400).json({ success: false, error: err.message });
      }
      handleRender(req, res);
    });
  } else {
    handleRender(req, res);
  }
});

// ================================
// Extract render options from payload
// ================================

function extractRenderOptions(body) {
  // Map frontend outputFit -> backend aspectMode
  //   "cover"    -> "cinematic"  (fills frame; allows crop)
  //   "contain"  -> "fit"        (letterbox, full image visible)
  //   "blur-pad" -> "blurpad"    (blurred-scaled bg + full image overlay)
  let aspectMode = String(body.aspectMode || body.aspect_mode || "").toLowerCase();
  if (!aspectMode) {
    const fit = String(body.outputFit || body.output_fit || body.fit || "").toLowerCase();
    if (fit === "blur-pad" || String(body.padMode || body.pad_mode || "").toLowerCase() === "blur" || body.blurBackground === true || body.blur_background === true || body.blurBackground === "true" || body.blur_background === "true") {
      aspectMode = "blurpad";
    } else if (fit === "contain") aspectMode = "fit";
    else if (fit === "cover")    aspectMode = "cinematic";
    else aspectMode = "fit";
  }

  // Overlay/watermark metadata
  let overlay = null;
  try {
    const raw = body.overlay || body.overlayMeta;
    if (raw) overlay = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) { overlay = null; }
  if (overlay && (overlay.enabled === false || overlay.enabled === "false")) overlay = null;

  // Audio chain (normalization now lives here, in the backend, not in the app UI)
  let audioIn = {};
  try {
    const raw = body.audio;
    if (raw) audioIn = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) { audioIn = {}; }

  const truthy = (v, dflt) =>
    v === undefined || v === null || v === "" ? dflt : (v === true || v === "true" || v === 1 || v === "1");

  const audioChain = {
    // Always normalize unless explicitly disabled — handled server-side.
    normalize:   truthy(audioIn.normalize ?? body.audioNormalize ?? body.audio_normalize ?? body.loudnorm, true),
    targetLUFS:  Number(audioIn.targetLUFS ?? body.targetLUFS ?? -16),
    voiceVolume: Math.max(0.2, Math.min(3, Number(audioIn.voiceVolume ?? body.voiceVolume ?? 1))),
    enhance:     truthy(audioIn.voiceEnhancement ?? audioIn.enhance ?? body.smoothAudio, false)
  };

  // Background music
  let musicIn = {};
  try {
    const raw = audioIn.music || audioIn.backgroundMusic || audioIn.background_music ||
                body.music || body.backgroundMusic || body.background_music;
    if (raw) musicIn = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) { musicIn = {}; }

  const musicChain = {
    enabled:   truthy(musicIn.enabled ?? body.musicEnabled, false),
    track:     musicIn.track ?? body.musicTrack ?? null,
    // Full volume control: 0 (silent) → 2 (double).
    volume:    Math.max(0, Math.min(2, Number(musicIn.volume ?? body.musicVolume ?? 0.15))),
    loop:      truthy(musicIn.loop ?? body.musicLoop, true),
    crossfade: Number(musicIn.crossfade === true ? 2 : (musicIn.crossfade ?? body.musicCrossfade ?? 2)),
    duck:      truthy(musicIn.duck ?? musicIn.autoDuck ?? body.musicDuck, true)
  };

  return {
    smoothAudio:   body.smoothAudio === true || body.smoothAudio === "true",
    crf:           body.crf || 21,
    preset:        body.preset || "faster",
    maxrate:       body.maxrate || "",
    bufsize:       body.bufsize || "",
    audioBitrate:  body.audioBitrate || "192k",
    movflags:      body.movflags || "+faststart",
    pixFmt:        body.pixFmt || "yuv420p",
    videoCodec:    body.videoCodec || "libx264",
    zoom:          body.zoom || null,
    zoomFactor:    body.zoomFactor || 1.0,
    cropX:         body.cropX || null,
    cropY:         body.cropY || null,
    focusX:        body.focusX || 0.5,
    focusY:        body.focusY || 0.5,
    aspectMode,
    overlay,
    audioChain,
    musicChain
  };
}

// ================================
// Render from uploaded panels (background)
// ================================

async function renderFromProject(req, jobId) {
  const projectId = safeName(req.body.project_id || req.body.projectId, "");

  if (!projectId) {
    return updateJob(jobId, { status: "error", error: "Missing project_id" });
  }

  const projectDir = path.join(UPLOADS_ROOT, projectId);

  if (!fs.existsSync(projectDir)) {
    return updateJob(jobId, {
      status: "error",
      error: `No uploaded panels found for project_id ${projectId}`
    });
  }

  let orderedRefs = [];
  try {
    if (Array.isArray(req.body.panels)) {
      orderedRefs = req.body.panels;
    } else if (typeof req.body.panels === "string") {
      orderedRefs = JSON.parse(req.body.panels);
    }
  } catch (_) {
    orderedRefs = [];
  }

  const readPanel = (panelId, fallbackIndex) => {
    const dir = path.join(
      projectDir,
      safeName(panelId, `panel_${fallbackIndex + 1}`)
    );
    const metaPath = path.join(dir, "metadata.json");
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return { ...meta, dir, index: fallbackIndex };
  };

  let panels = [];

  if (orderedRefs.length) {
    panels = orderedRefs
      .map((p, i) => readPanel(p.ref || p.panel_id || p.id || p.panel, i))
      .filter(Boolean);
  } else {
    const folders = fs
      .readdirSync(projectDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    panels = folders.map((name, i) => readPanel(name, i)).filter(Boolean);
    panels.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  }

  if (!panels.length) {
    return updateJob(jobId, { status: "error", error: "No complete panels found to render" });
  }

  updateJob(jobId, { status: "processing", progress: 0 });

  const batchIndex   = Number(req.body.batchIndex   || req.body.batch_index   || 0);
  const totalBatches = Number(req.body.totalBatches || req.body.total_batches || 1);
  const panelCount   = panels.length;
  const renderOptions = extractRenderOptions(req.body);
  if (req._overlayPath && fs.existsSync(req._overlayPath)) {
    renderOptions.overlayPath = req._overlayPath;
  }
  if (req._musicPath && fs.existsSync(req._musicPath)) {
    renderOptions.musicChain.filePath = req._musicPath;
    renderOptions.musicChain.enabled = true;
  }

  updateJob(jobId, { batchIndex, totalBatches });

  const segPaths  = [];
  const durations = [];

  try {
    console.log(`[${RENDERER_NAME}][${jobId}] Starting validation — ${panels.length} panels`);
    await validateRenderPanels(panels);

    console.log(`[${RENDERER_NAME}][${jobId}] Starting render — ${panels.length} panels — batch ${batchIndex + 1}/${totalBatches} — panelCount=${panelCount}`);

    let skipped = 0;
    for (let i = 0; i < panels.length; i++) {
      const p   = panels[i];
      p.index = i;
      const dur = await calculatePanelDuration(p);
      const segPath = path.join(TEMP_ROOT, `seg_${jobId}_${i}.mp4`);

      const perPanelOpts = {
        ...renderOptions,
        zoomFactor: Number(p.zoom || 1),
        focusX:     Number(p.focusX != null ? p.focusX : 0.5),
        focusY:     Number(p.focusY != null ? p.focusY : 0.5)
      };

      const result = await createSegmentSafe({
        imagePath: path.join(p.dir, p.image),
        audioPath: p.audio ? path.join(p.dir, p.audio) : null,
        text:      p.narration || "",
        duration:  dur,
        outPath:   segPath,
        jobId,
        idx: i,
        panelCount,
        aspectMode: renderOptions.aspectMode,
        renderOptions: perPanelOpts
      });

      if (result.success) {
        segPaths.push(segPath);
        durations.push(dur);
      } else {
        skipped++;
        console.warn(`[${jobId}] Panel ${i + 1} skipped (${skipped} total skipped)`);
      }

      const pct = Math.round(((i + 1) / panels.length) * 80);
      updateJob(jobId, { progress: pct, skipped });
    }

    if (!segPaths.length) {
      throw new Error("All panels failed to render — no segments produced.");
    }
    if (skipped > 0) {
      console.warn(`[${jobId}] ⚠ ${skipped} panels were skipped due to errors`);
    }

    updateJob(jobId, { progress: 85 });

    const finalPath = path.join(OUTPUT_ROOT, `${jobId}_final.mp4`);
    await concatWithTransitions(segPaths, durations, finalPath, renderOptions);
    cleanupFiles(segPaths);

    updateJob(jobId, { progress: 92 });
    const mixInfo = await finalizeAudio(finalPath, durations, renderOptions);

    const host = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || req.get("host")}`;
    const url  = `${host}/output/${jobId}_final.mp4`;

    setTimeout(() => {
      try { fs.unlinkSync(finalPath); } catch (_) {}
    }, 2 * 60 * 60 * 1000);

    updateJob(jobId, {
      status: "done",
      progress: 100,
      url,
      videoUrl: url,
      video_url: url,
      download_url: url,
      project_id: projectId,
      panels: panels.length,
      rendered: segPaths.length,
      skipped,
      batchIndex,
      totalBatches,
      renderer: RENDERER_NAME,
      music: mixInfo.music,
      audioNormalized: renderOptions.audioChain.normalize !== false,
      format: "MP4 (H264 Video + AAC Audio)",
      device_support: "Universal (iOS, Android, Chrome, Safari, Edge)",
      fps: 15,
      aspectMode: renderOptions.aspectMode,
      encodingSettings: {
        crf: renderOptions.crf,
        preset: renderOptions.preset,
        concat: "stream-copy"
      }
    });

    scheduleJobEviction(jobId);
    console.log(`[${RENDERER_NAME}][${jobId}] Render complete → ${url}`);

  } catch (err) {
    console.error(`[${jobId}] Render ERROR:`, err.message);
    cleanupFiles(segPaths);
    updateJob(jobId, { status: "error", error: err.message });
    scheduleJobEviction(jobId);
  }
}

// ================================
// Render from multipart upload (background)
// ================================

async function renderFromMultipart(req, jobId) {
  const segPaths    = [];
  const durations   = [];
  
  // FIX: Use req.files.images array instead of req.files (because .fields() changes structure)
  const imageFiles = req.files.images || [];
  const uploadPaths = imageFiles.map((f) => f.path);

  if (!imageFiles?.length) {
    return updateJob(jobId, { status: "error", error: "No images uploaded." });
  }

  updateJob(jobId, { status: "processing", progress: 0 });

  const batchIndex   = Number(req.body.batchIndex   || req.body.batch_index   || 0);
  const totalBatches = Number(req.body.totalBatches || req.body.total_batches || 1);
  const panelCount   = imageFiles.length;
  const renderOptions = extractRenderOptions(req.body);

  updateJob(jobId, { batchIndex, totalBatches });

  try {
    const lines = String(req.body.narration || "")
      .split("\n")
      .map((l) => l.trim());

    while (lines.length < imageFiles.length) lines.push("");

    console.log(`[${RENDERER_NAME}][${jobId}] Starting multipart render — ${imageFiles.length} images — batch ${batchIndex + 1}/${totalBatches}`);

    let skipped = 0;
    for (let i = 0; i < imageFiles.length; i++) {
      const segPath  = path.join(TEMP_ROOT, `seg_${jobId}_${i}.mp4`);
      const wordCount = String(lines[i] || "").split(/\s+/).filter(Boolean).length;
      const dur = Math.max(3, Math.min(12, Math.round(wordCount / 2.3) + 1));

      const result = await createSegmentSafe({
        imagePath: imageFiles[i].path,
        audioPath: null,
        text:      lines[i] || "",
        duration:  dur,
        outPath:   segPath,
        jobId,
        idx: i,
        panelCount,
        aspectMode: renderOptions.aspectMode,
        renderOptions
      });

      if (result.success) {
        segPaths.push(segPath);
        durations.push(dur);
      } else {
        skipped++;
        console.warn(`[${jobId}] Panel ${i + 1} skipped (${skipped} total skipped)`);
      }

      const pct = Math.round(((i + 1) / imageFiles.length) * 80);
      updateJob(jobId, { progress: pct, skipped });
    }

    if (!segPaths.length) {
      throw new Error("All panels failed to render — no segments produced.");
    }
    if (skipped > 0) {
      console.warn(`[${jobId}] ⚠ ${skipped} panels were skipped due to errors`);
    }

    updateJob(jobId, { progress: 85 });

    const finalPath = path.join(OUTPUT_ROOT, `${jobId}_final.mp4`);
    await concatWithTransitions(segPaths, durations, finalPath, renderOptions);
    cleanupFiles([...segPaths, ...uploadPaths]);

    updateJob(jobId, { progress: 92 });
    const mixInfo = await finalizeAudio(finalPath, durations, renderOptions);

    const host = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || req.get("host")}`;
    const url  = `${host}/output/${jobId}_final.mp4`;

    setTimeout(() => {
      try { fs.unlinkSync(finalPath); } catch (_) {}
    }, 2 * 60 * 60 * 1000);

    updateJob(jobId, {
      status: "done",
      progress: 100,
      url,
      videoUrl: url,
      video_url: url,
      download_url: url,
      panels: imageFiles.length,
      rendered: segPaths.length,
      skipped,
      batchIndex,
      totalBatches,
      renderer: RENDERER_NAME,
      music: mixInfo.music,
      audioNormalized: renderOptions.audioChain.normalize !== false,
      format: "MP4 (H264 Video + AAC Audio)",
      device_support: "Universal (iOS, Android, Chrome, Safari, Edge)",
      fps: 15,
      aspectMode: renderOptions.aspectMode,
      encodingSettings: {
        crf: renderOptions.crf,
        preset: renderOptions.preset,
        concat: "stream-copy"
      }
    });

    scheduleJobEviction(jobId);
    console.log(`[${RENDERER_NAME}][${jobId}] Multipart render complete → ${url}`);

  } catch (err) {
    console.error(`[${jobId}] Multipart render ERROR:`, err.message);
    cleanupFiles([...segPaths, ...uploadPaths]);
    updateJob(jobId, { status: "error", error: err.message });
    scheduleJobEviction(jobId);
  }
}

// ================================
// 404
// ================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error:   "Route not found",
    path:    req.originalUrl
  });
});

// ================================
// Auto Cleanup (every 30 min)
// ================================

setInterval(() => {
  const now = Date.now();

  [OUTPUT_ROOT, TEMP_ROOT].forEach((dir) => {
    try {
      fs.readdirSync(dir).forEach((file) => {
        const full = path.join(dir, file);
        try {
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > 2 * 60 * 60 * 1000) {
            fs.unlinkSync(full);
            console.log(`[cleanup] Deleted old file: ${file}`);
          }
        } catch (_) {}
      });
    } catch (_) {}
  });
}, 30 * 60 * 1000);

// ================================
// START
// ================================

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`ScriptReel running on port ${PORT}`);
  console.log(`Renderer: ${RENDERER_NAME}`);
  console.log(`FFmpeg: ${FFMPEG_PATH}`);
});

// FIX #4: Add Upload Timeout Safety
server.timeout = 0;
