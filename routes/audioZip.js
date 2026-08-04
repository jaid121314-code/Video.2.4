"use strict";

const express = require("express");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const AdmZip = require("adm-zip");
const config = require("../config");
const { safeName, readJson, writeJson, remove } = require("../utils/files");
const { zipUpload } = require("../utils/uploads");
const { logger } = require("../utils/logger");

const router = express.Router();

router.post("/audio-zip", zipUpload.single("audioZip"), async (req, res) => {
  const uploaded = req.file?.path;
  try {
    const projectId = safeName(req.body.project_id || req.body.projectId, "");
    if (!projectId) return res.status(400).json({ success: false, error: "Missing project_id" });
    if (!uploaded) return res.status(400).json({ success: false, error: "audioZip file required" });

    const projectDir = path.join(config.dirs.uploads, projectId);
    if (!fs.existsSync(projectDir)) {
      return res.status(404).json({ success: false, error: "Project not found. Upload panels first." });
    }

    // AdmZip reads lazily from the path — the old code loaded the entire ZIP
    // into a Buffer first (a 500 MB ZIP meant 500 MB of RSS).
    const zip = new AdmZip(uploaded);

    const tracks = zip
      .getEntries()
      .filter((e) => !e.isDirectory)
      .filter((e) => {
        const name = e.entryName.replace(/\\/g, "/");
        if (name.includes("__MACOSX")) return false;
        if (path.basename(name).startsWith(".")) return false;
        return /\.(mp3|m4a|wav)$/i.test(name);
      })
      .map((e) => {
        const base = path.basename(e.entryName);
        const m = base.match(/(\d+)/);
        return m ? { entry: e, num: Number(m[1]), file: base, ext: path.extname(base).toLowerCase() } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.num - b.num);

    if (!tracks.length) {
      return res.status(400).json({
        success: false,
        error: "No numbered audio found. Use 1.mp3, 2.mp3, audio_1.mp3, panel_1.mp3, …",
      });
    }

    const dirs = (await fsp.readdir(projectDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const panels = [];
    for (const name of dirs) {
      const metaPath = path.join(projectDir, name, "metadata.json");
      const meta = await readJson(metaPath);
      if (meta) panels.push({ name, dir: path.join(projectDir, name), metaPath, meta });
    }
    panels.sort((a, b) => Number(a.meta.index || 0) - Number(b.meta.index || 0));

    const attached = [];
    const missing = [];

    await Promise.all(
      panels.map(async (panel, i) => {
        const track = tracks.find((t) => t.num === i + 1);
        if (!track) {
          missing.push(i + 1);
          return;
        }
        const outName = `audio${track.ext}`;
        await fsp.writeFile(path.join(panel.dir, outName), track.entry.getData());
        panel.meta.audio = outName;
        panel.meta.audio_source = "zip";
        panel.meta.audio_original = track.file;
        await writeJson(panel.metaPath, panel.meta);
        attached.push({ panel: i + 1, image: panel.meta.image, audio: track.file, status: "attached" });
      }),
    );

    attached.sort((a, b) => a.panel - b.panel);
    missing.sort((a, b) => a - b);

    res.json({
      success: true,
      project_id: projectId,
      totalPanels: panels.length,
      totalMp3Found: tracks.length,
      attached,
      missing,
      message: missing.length
        ? `Attached ${attached.length} audio files. Missing audio for panels: ${missing.join(", ")}`
        : `All ${attached.length} audio files attached successfully.`,
    });
  } catch (err) {
    logger.error("audio-zip", err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    // Always removed, including on failure (old code leaked the ZIP on error).
    await remove([uploaded]);
  }
});

module.exports = router;
