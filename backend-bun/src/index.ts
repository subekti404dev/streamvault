import { loadConfig } from "./config";
import { createDb } from "./db/index";
import { createApp } from "./app";
import { EventBus, SseClient, startKeepAlive } from "./api/events";
import { setNotificationGlobals } from "./notifications/telegram";
import { recoverStaleJobs } from "./worker/monitor";
import { worker } from "./worker/scheduler";

const config = loadConfig();
const db = createDb();
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
import { listLibrary, requeueJobHandler, getLibraryItem } from "./api/library";
import { progressCallback, checkpointCallback, completeCallback, failedCallback } from "./api/callbacks";
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
  const stream = sseClient.start(eventBus);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});
api.get("/settings", getSettings);
api.put("/settings", updateSettings);
api.post("/settings/test-notification", testNotification);
api.get("/library", listLibrary);
api.post("/library/:id/requeue", requeueJobHandler);
api.get("/library/:imdbId", getLibraryItem);
app.route("/api/v1", api);

// Callback sub-router — X-Callback-Token auth
const cb = new Hono();
cb.use("*", callbackAuthMiddleware);
cb.post("/:id/progress", progressCallback);
cb.post("/:id/checkpoint", checkpointCallback);
cb.post("/:id/complete", completeCallback);
cb.post("/:id/failed", failedCallback);
app.route("/api/v1/jobs", cb);

// Public Stremio addon routes
app.get("/manifest.json", manifestHandler);
app.get("/catalog/:type/:catalogId.json", catalogHandler);
app.get("/meta/:type/:imdbId.json", metaHandler);
app.get("/stream/:type/:id.json", streamHandler);
app.get("/proxy/hls/:jobId/master.m3u8", playlistHandler);
app.get("/proxy/hls/:jobId/*", chunkHandler);

// Static file serving — Svelte dashboard (fallback for SPA)
app.use("/*", serveStatic({ root: config.dashboardDir }));
app.get("/*", serveStatic({ path: `${config.dashboardDir}/index.html` }));

// ── Startup ──
startKeepAlive();
recoverStaleJobs(db);
worker(db, config, eventBus);

// ── Serve ──
console.log(`StreamVault Bun serving on http://0.0.0.0:8080`);
export default {
  port: 8080,
  fetch: app.fetch,
};
