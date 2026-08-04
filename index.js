"use strict";

const express = require("express");
const cors = require("cors");
const config = require("./config");
const { logger, mem } = require("./utils/logger");
const { ensureDirs } = require("./utils/files");
const { initFfmpeg } = require("./utils/ffmpeg");
const { startCleanupLoop } = require("./utils/cleanup");
const jobStore = require("./jobs/store");

const panelRoutes = require("./routes/panel");
const audioZipRoutes = require("./routes/audioZip");
const renderRoutes = require("./routes/render");
const musicRoutes = require("./routes/music");
const { router: systemRoutes } = require("./routes/system");

ensureDirs();
initFfmpeg();

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Rendered videos are served straight from disk with range support so mobile
// players can seek without downloading the whole file.
app.use(
  "/output",
  express.static(config.dirs.output, {
    maxAge: "1h",
    setHeaders: (res) => res.setHeader("Accept-Ranges", "bytes"),
  }),
);

app.use(systemRoutes);
app.use(panelRoutes);
app.use(audioZipRoutes);
app.use(renderRoutes);
app.use(musicRoutes);

app.use((err, _req, res, _next) => {
  logger.error("http", err.message);
  res.status(err.status || 500).json({ success: false, error: err.message });
});

startCleanupLoop();
jobStore.startEviction();

const server = app.listen(config.port, "0.0.0.0", () => {
  logger.info("boot", `listening on :${config.port} · concurrency=${config.renderConcurrency} · mem=${mem()}MB`);
});

server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 120000;

function shutdown(signal) {
  logger.info("boot", `${signal} received, closing`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => logger.error("unhandled", String(e?.message || e)));

module.exports = app;
