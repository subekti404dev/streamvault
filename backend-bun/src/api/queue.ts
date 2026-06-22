import type { Context } from "hono";
import type { AppBindings } from "../app";
import { badRequest } from "../error";
import * as queries from "../db/queries";
import { triggerPipeline, cancelGhRun } from "../pipeline/trigger";
import { sendNotification } from "../notifications/telegram";
import { buildMagnet } from "./search";

const ACTIVE_STATUSES = [
  "processing",
  "downloading",
  "checkpoint_download",
  "transcoding",
  "checkpoint_transcode",
  "uploading",
];

export async function createJob(c: Context<AppBindings>) {
  const raw = await c.req.json();
  const body = raw as Record<string, unknown>;
  // Required fields — match Rust CreateJobRequest validation
  const imdbId = body.imdb_id;
  const mediaType = body.media_type;
  const infohash = body.infohash;
  const torrentName = (body.torrent_name as string) ?? "";
  const title = (body.title as string) ?? torrentName;

  if (!imdbId || typeof imdbId !== "string" || !imdbId.trim()) throw badRequest("imdb_id is required");
  if (!mediaType || typeof mediaType !== "string" || !mediaType.trim()) throw badRequest("media_type is required");
  if (!infohash || typeof infohash !== "string" || !infohash.trim()) throw badRequest("infohash is required");

  // Auto-construct magnet URI with trackers if not provided (backward compat)
  const magnetUri = (body.magnet_uri as string)?.trim()
    || buildMagnet(infohash, title);

  const jobId = crypto.randomUUID();

  const newJob: queries.NewJob = {
    id: jobId,
    imdbId: imdbId,
    mediaType: mediaType,
    season: (body.season as number | undefined) ?? null,
    episode: (body.episode as number | undefined) ?? null,
    title: title || null,
    posterUrl: (body.poster_url as string | undefined) ?? null,
    magnetUri: magnetUri,
    infohash: infohash,
    torrentName: torrentName || null,
    fileIdx: (body.file_idx as number) ?? 0,
    fileSizeBytes: (body.file_size_bytes as number) ?? 0,
  };

  queries.insertJob(c.var.db, newJob);
  queries.insertJobEvent(c.var.db, jobId, null, "status_change", "Job queued", null);

  const eventTitle = newJob.title ?? "";
  c.var.eventBus.send({ type: "job_created", data: { job_id: jobId, title: eventTitle } });
  sendNotification(c, { type: "JobQueued", title: eventTitle });

  return c.json({ job_id: jobId, status: "queued" }, 201);
}

export async function listJobs(c: Context<AppBindings>) {
  const allJobs = queries.listJobs(c.var.db);

  const processing: queries.Job[] = [];
  const queued: queries.Job[] = [];
  const completed: queries.Job[] = [];
  const failed: queries.Job[] = [];

  for (const job of allJobs) {
    if (ACTIVE_STATUSES.includes(job.status)) {
      processing.push(job);
    } else if (job.status === "queued") {
      queued.push(job);
    } else if (job.status === "completed") {
      completed.push(job);
    } else if (job.status === "failed") {
      failed.push(job);
    } else {
      // ponytail: unknown status fallback — treat as queued
      queued.push(job);
    }
  }

  return c.json({ processing, queued, completed, failed });
}

export async function getJob(c: Context<AppBindings>) {
  const id = c.req.param("id") as string;
  const job = queries.getJob(c.var.db, id);
  const events = queries.getJobEvents(c.var.db, id);
  const ghRepo = queries.getSetting(c.var.db, "gh_repo") || c.var.config.ghRepo || null;

  return c.json({ job, events, gh_repo: ghRepo });
}

export async function retryJob(c: Context<AppBindings>) {
  const id = c.req.param("id") as string;
  const job = queries.getJob(c.var.db, id);

  if (job.status !== "failed") {
    throw badRequest("Can only retry failed jobs");
  }

  const skipDownload =
    (job.lastCheckpoint === "download" || job.lastCheckpoint === "transcode") &&
    job.ghArtifactDlUrl != null;
  const skipTranscode =
    job.lastCheckpoint === "transcode" && job.ghArtifactTcUrl != null;

  queries.insertJobEvent(
    c.var.db,
    id,
    null,
    "status_change",
    `Retry triggered (last checkpoint: ${job.lastCheckpoint}, skip_dl: ${skipDownload}, skip_tc: ${skipTranscode})`,
    null,
  );

  try {
    const runId = await triggerPipeline(c, job, skipDownload, skipTranscode);
    queries.updateJobStatus(c.var.db, id, "processing");
    queries.insertJobEvent(
      c.var.db,
      id,
      null,
      "status_change",
      `Retry pipeline triggered (run_id: ${runId})`,
      null,
    );
    c.var.eventBus.send({ type: "job_retried", data: { job_id: id } });
    return c.json({ job_id: id, status: "processing" });
  } catch (e) {
    throw badRequest((e as Error).message);
  }
}

export async function deleteJobHandler(c: Context<AppBindings>) {
  const id = c.req.param("id") as string;
  const job = queries.getJob(c.var.db, id);

  const isActive = ACTIVE_STATUSES.includes(job.status);

  if (isActive && job.ghRunId && job.ghRunId !== "pending") {
    const ghToken = queries.getSetting(c.var.db, "gh_token") || c.var.config.ghToken || "";
    const ghRepo = queries.getSetting(c.var.db, "gh_repo") || c.var.config.ghRepo || "";
    if (ghToken && ghRepo) {
      try {
        await cancelGhRun(ghToken, ghRepo, job.ghRunId);
      } catch (e) {
        console.error(`[queue] Failed to cancel GH run ${job.ghRunId}:`, (e as Error).message);
      }
    }
  }

  queries.deleteJob(c.var.db, id);
  c.var.eventBus.send({ type: "job_removed", data: { job_id: id } });

  return c.json({ removed: true, cancelled_run: isActive });
}
