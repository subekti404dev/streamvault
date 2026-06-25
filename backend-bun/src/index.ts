import { loadConfig } from "./config";
import { createDb } from "./db/index";
import { createApp } from "./app";
import { EventBus, SseClient, trackSseClient, startKeepAlive } from "./api/events";
import { setNotificationGlobals } from "./notifications/telegram";
import { recoverStaleJobs } from "./worker/monitor";
import { worker } from "./worker/scheduler";

const config = loadConfig();
const db = createDb(config.databaseUrl);
const eventBus = new EventBus();

// Set globals for background worker (scheduler)
setNotificationGlobals(db, config);

const app = createApp(config, db, eventBus);

// ── Wire all API routes ──

import { Hono } from "hono";
import { authMiddleware, callbackAuthMiddleware } from "./api/auth";
import { searchHandler } from "./api/search";
import { inspectTorrent } from "./api/torrent";
import { createJob, listJobs, getJob, retryJob, deleteJobHandler } from "./api/queue";
import { getSettings, updateSettings, testNotification } from "./api/settings";
import { listLibrary, requeueJobHandler, getLibraryItem, deleteLibraryItem } from "./api/library";
import { progressCallback, completeCallback, failedCallback } from "./api/callbacks";
import { exportHandler, importHandler } from "./api/backup";
import { manifestHandler, catalogHandler, metaHandler, streamHandler } from "./stremio/routes";
import { playlistHandler, chunkHandler } from "./stremio/proxy";
import { serveStatic } from "hono/bun";

// API sub-router — Bearer auth required
const api = new Hono();
api.use("*", authMiddleware);
api.post("/search", searchHandler);
api.post("/torrent/inspect", inspectTorrent);
api.post("/queue", createJob);
api.get("/queue", listJobs);
api.get("/queue/:id", getJob);
api.post("/queue/:id/retry", retryJob);
api.delete("/queue/:id", deleteJobHandler);
api.get("/events", (c) => {
  const sseClient = new SseClient();
  trackSseClient(sseClient);
  const stream = sseClient.start(eventBus);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",   // nginx
    },
  });
});
api.get("/settings", getSettings);
api.put("/settings", updateSettings);
api.post("/settings/test-notification", testNotification);
api.get("/library", listLibrary);
api.post("/library/:id/requeue", requeueJobHandler);
api.get("/library/:imdbId", getLibraryItem);
api.delete("/library/:imdbId", deleteLibraryItem);
api.get("/export", exportHandler);
api.post("/import", importHandler);

// CRITICAL: Callback sub-router MUST be registered BEFORE /api/v1 router.
// Hono tries sub-routers in registration order; /api/v1/jobs/* also
// matches /api/v1 which would intercept callbacks with the wrong auth.
const cb = new Hono();
cb.use("*", callbackAuthMiddleware);
cb.post("/:id/progress", progressCallback);
cb.post("/:id/complete", completeCallback);
cb.post("/:id/failed", failedCallback);
app.route("/api/v1/jobs", cb);

app.route("/api/v1", api);

// Public Stremio addon routes
app.get("/manifest.json", manifestHandler);
app.get("/catalog/:type/:catalogId", catalogHandler);
app.get("/meta/:type/:imdbId", metaHandler);
app.get("/stream/:type/:id", streamHandler);
// HLS proxy — auth required (token embedded by streamHandler for Stremio clients)
app.use("/proxy/hls/*", authMiddleware);

app.get("/proxy/hls/:jobId/master.m3u8", playlistHandler);
app.get("/proxy/hls/:jobId/:filename", chunkHandler);

// Static file serving — Svelte dashboard (SPA fallback)
// serveStatic returns 404 on missing files and does NOT call next(),
// so we only match exact static assets with the wildcard, then
// use notFound to serve index.html for SPA client-side routing.
app.use("/assets/*", serveStatic({ root: config.dashboardDir }));
app.use("/favicon.svg", serveStatic({ path: `${config.dashboardDir}/favicon.svg` }));
app.use("/icons.svg", serveStatic({ path: `${config.dashboardDir}/icons.svg` }));
app.notFound((c) => {
  // Serve index.html for SPA client-side routing
  const indexFile = Bun.file(`${config.dashboardDir}/index.html`);
  if (indexFile.size > 0) {
    return new Response(indexFile.stream(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return c.text("Not Found", 404);
});

// ── Startup ──
startKeepAlive();
recoverStaleJobs(db);
const stopWorker = worker(db, config, eventBus);
process.on("SIGTERM", () => {
  console.log("[server] SIGTERM received — shutting down");
  stopWorker();
  process.exit(0);
});

// ── Serve ──
console.log(`StreamVault Bun serving on http://0.0.0.0:8080`);
export default {
  port: 8080,
  fetch: app.fetch,
};
