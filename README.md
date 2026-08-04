# ScriptReel Renderer 2.4 — modular backend

Drop-in replacement for the old single-file `index.js`. **All existing API
routes and response shapes are unchanged**, so the current frontend keeps
working without any edit.

```
backend/
  index.js              app bootstrap only (mounts routes, starts loops)
  config.js             every tunable in one place (env-overridable)
  routes/
    panel.js            POST /panel, GET /project/:id
    audioZip.js         POST /audio-zip
    render.js           POST /render, GET /status/:jobId
    music.js            GET/POST/DELETE /music
    system.js           GET /, /health, POST /stitch
  audio/
    speed.js            pitch-corrected atempo chain
    normalize.js        EBU R128 loudnorm (-16 LUFS default)
    enhance.js          voice EQ + compressor + limiter
    chain.js            builds the ONE filter graph for the whole voice path
    musicLoop.js        library, looping and crossfading of music beds
    mixer.js            ducking mix onto the finished video (video stream-copied)
  video/
    resolution.js       resolution presets + Auto FPS
    filters.js          Ken Burns, fit/cover/blur-pad, overlay
    clipGenerator.js    one clip per panel, parallel + OOM retry
    merge.js            concat demuxer, stream-copy (no re-encode)
    options.js          request → normalised options (back-compatible)
    renderer.js         job orchestration
  jobs/store.js         in-memory job registry with bounded eviction
  utils/                logger, ffmpeg runner + probe cache, files, cleanup,
                        concurrency pool, multer storages
```

## What got faster

| Before | Now |
| --- | --- |
| Panels encoded one after another | Parallel pool, `RENDER_CONCURRENCY` (default cores−1) |
| Audio probed twice per panel | Probed once, memoised, freed after use |
| Speed / normalize / volume = separate FFmpeg passes writing temp WAVs | One filter graph inside the clip encode — no intermediate files |
| Final concat re-encoded the whole video | Concat demuxer with `-c copy` |
| Music mix re-encoded video + audio | Audio-only re-encode, `-c:v copy` |
| Panel upload: write → read to Buffer → write → unlink | Multer streams straight to the final path |
| ZIP read fully into memory | Read lazily from disk |
| One `setTimeout` per job, temp leaks on error paths | Single sweep loop + `TempScope` guaranteed cleanup |
| Hardcoded 15 fps, fixed 1280×720 | `fps` (15/20/24/25/30/auto) and `resolution` per request |

## Audio pipeline

Applied in this exact order inside a single graph:

`speed (atempo) → loudnorm → voice enhancement (high-pass, presence EQ, de-ess)
→ compressor → limiter → volume`

Background music is mixed after the video is assembled:
looped to length with a crossfade, capped at `maxMusicGain`, and side-chain
ducked so narration always sits above the bed.

## API additions (all optional)

```jsonc
POST /render
{
  "project_id": "…",              // unchanged
  "fps": "auto",                  // or 15 | 20 | 24 | 25 | 30
  "resolution": "1080p",          // 720p | 1080p | vertical | square | 1920x1080
  "audio": {
    "speed": 1.0,
    "voiceVolume": 1.0,
    "normalize": true,
    "targetLUFS": -16,
    "voiceEnhancement": true,
    "backgroundMusic": {
      "enabled": true,
      "track": "calm.mp3",        // from GET /music, or upload a `music` file
      "volume": 0.18,
      "loop": true,
      "crossfade": 2,
      "duck": true
    }
  }
}
```

Omit any of it and the renderer behaves exactly like 2.3.

## Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | 8080 | listen port |
| `RENDER_CONCURRENCY` | cores − 1 (max 4) | parallel clip encodes |
| `FFMPEG_THREADS` | 0 (auto) | threads per FFmpeg process |
| `DEFAULT_FPS` | 20 | used when `fps` is omitted and Auto is off |
| `DEFAULT_RESOLUTION` | 1280x720 | fallback output size |
| `DEFAULT_CRF` / `DEFAULT_PRESET` | 21 / faster | x264 quality |
| `TARGET_LUFS` | -16 | loudnorm target |
| `FILE_TTL_MS` | 2 h | output/temp retention |
| `LOG_LEVEL` | info | error \| warn \| info \| debug |

## Railway

`Dockerfile` is slim (bookworm-slim, no dev deps, cleaned apt lists) and sets
`--max-old-space-size=512` so a 512 MB dyno never gets OOM-killed by V8 before
FFmpeg gets its memory. Health check hits `/health`, which now also reports
concurrency, RSS and renderer capabilities.

Add your own music beds by dropping MP3s into `assets/music/`.
