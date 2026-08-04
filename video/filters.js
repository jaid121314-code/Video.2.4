"use strict";

/**
 * Ken Burns / aspect handling.
 *
 * Changes vs. the original:
 *  - fps, width and height are parameters (were hardcoded 15 / 1280x720);
 *  - the oversample scale is derived from the output width instead of a fixed
 *    2560 (rendering 720p no longer decodes a needless 2560px intermediate —
 *    this alone is a large CPU saving);
 *  - the redundant trailing `scale`/`setsar` that was appended twice per clip
 *    has been removed (the old vfParts pushed `setsar=1` after a filter that
 *    already ended in `setsar=1`).
 */

function kenBurnsFilter({ idx = 0, duration, fps, width, height, mode = "fit", zoomPercent = 18 }) {
  const frames = Math.max(2, Math.ceil(duration * fps));
  const normalised = String(mode || "fit").toLowerCase().trim();
  const zMax = 1 + Math.max(1, Math.min(40, Number(zoomPercent) || 18)) / 100;
  const zStep = ((zMax - 1) / frames).toFixed(6);
  const S = `${width}x${height}`;
  // 2x oversample keeps zoompan smooth without the fixed 2560px blow-up.
  const over = width * 2;

  const fit = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;

  if (normalised === "static" || normalised === "none") {
    return fit;
  }

  const zp = (expr) =>
    `scale=${over}:-1,zoompan=${expr}:d=${frames}:s=${S}:fps=${fps}`;

  const moves = [
    zp(`z='min(zoom+${zStep},${zMax})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`),
    zp(`z='if(lte(on,1),${zMax},max(zoom-${zStep},1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`),
    zp(`z='${zMax}':x='if(lte(on,1),iw*0.10,min(x+iw*0.08/${frames},iw*0.18))':y='ih/2-(ih/zoom/2)'`),
    zp(`z='${zMax}':x='if(lte(on,1),iw*0.18,max(x-iw*0.08/${frames},iw*0.10))':y='ih/2-(ih/zoom/2)'`),
    zp(`z='${zMax}':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.08,min(y+ih*0.08/${frames},ih*0.16))'`),
    zp(`z='${zMax}':x='iw/2-(iw/zoom/2)':y='if(lte(on,1),ih*0.16,max(y-ih*0.08/${frames},ih*0.08))'`),
  ];

  const move = moves[idx % moves.length];

  if (normalised === "cinematic" || normalised === "cover") {
    return `${move},setsar=1`;
  }

  if (normalised === "blurpad" || normalised === "blur-pad" || normalised === "blur_pad") {
    return (
      `split[bg][fg];` +
      `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=22,eq=brightness=-0.05[bg2];` +
      `[fg]${move},scale=${width}:${height}:force_original_aspect_ratio=decrease[fg2];` +
      `[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1`
    );
  }

  // Default: fit (letterbox) with Ken Burns.
  return `${move},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
}

/** Optional per-panel manual zoom/crop, appended to the base chain. */
function manualZoomFilter({ zoomFactor, focusX = 0.5, focusY = 0.5, width, height }) {
  const z = parseFloat(zoomFactor);
  if (!Number.isFinite(z) || z <= 1.0 || z > 3.0) return null;
  const fx = Math.max(0, Math.min(1, Number(focusX)));
  const fy = Math.max(0, Math.min(1, Number(focusY)));
  const cw = Math.round(width / z / 2) * 2;
  const ch = Math.round(height / z / 2) * 2;
  const cx = Math.round((width - cw) * fx);
  const cy = Math.round((height - ch) * fy);
  return `crop=${cw}:${ch}:${cx}:${cy},scale=${width}:${height}`;
}

/** Watermark/logo overlay expression. */
function overlayGraph({ baseChain, overlay, width, inputIndex }) {
  const pos = overlay?.position || "top-right";
  const sizePct = Math.max(3, Math.min(40, Number(overlay?.sizePct ?? 12)));
  const margin = Math.max(0, Math.min(200, Number(overlay?.marginPx ?? 16)));
  const opacity = Math.max(0.05, Math.min(1, Number(overlay?.opacity ?? 1)));
  const wmW = Math.round((width * sizePct) / 100);

  let x;
  let y;
  if (pos === "top-left") { x = String(margin); y = String(margin); }
  else if (pos === "bottom-left") { x = String(margin); y = `H-h-${margin}`; }
  else if (pos === "bottom-right") { x = `W-w-${margin}`; y = `H-h-${margin}`; }
  else { x = `W-w-${margin}`; y = String(margin); }

  return (
    `[0:v]${baseChain}[bgv];` +
    `[${inputIndex}:v]scale=${wmW}:-1,format=rgba,colorchannelmixer=aa=${opacity}[wm];` +
    `[bgv][wm]overlay=${x}:${y}:format=auto[outv]`
  );
}

module.exports = { kenBurnsFilter, manualZoomFilter, overlayGraph };
