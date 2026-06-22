import type { Context } from "hono";
import type { AppBindings } from "../app";
import { badRequest } from "../error";
import * as queries from "../db/queries";
import { sendNotification } from "../notifications/telegram";

export async function progressCallback(c: Context<AppBindings>): Promise<Response> {
  const id = c.req.param("id") as string;
  const body = await c.req.json<Record<string, any>>();
  const phase: string = body.phase ?? "download";
  const progressPct: number = body.progress_pct ?? 0;

  queries.updateJobProgress(c.var.db, id, phase, progressPct);
  queries.updateJobPhase(c.var.db, id, phase);

  // Insert HLS chunk info if present
  if (body.chunk) {
    queries.insertHlsChunk(c.var.db, {
      jobId: id,
      chunkIndex: body.chunk.chunk_index ?? 0,
      filename: body.chunk.filename,
      discordUrl: body.chunk.discord_url ?? null,
      discordMessageId: body.chunk.discord_message_id ?? null,
      durationSeconds: body.chunk.duration_seconds ?? null,
      fileSizeBytes: null,
    });
  }

  // Log event
  queries.insertJobEvent(c.var.db, id, phase, "progress", `Progress: ${progressPct}%`, progressPct);

  // Broadcast
  c.var.eventBus.send({ type: "job_progress", data: { job_id: id, phase, progress_pct: progressPct } });

  return c.json({ ok: true });
}

export async function checkpointCallback(c: Context<AppBindings>): Promise<Response> {
  const id = c.req.param("id") as string;
  const body = await c.req.json<Record<string, any>>();
  if (!body.checkpoint) throw badRequest("Missing checkpoint field");

  const artifactId = body.artifact_id ?? null;
  const fileUrl = body.file_url ?? null;

  queries.updateJobCheckpoint(c.var.db, id, body.checkpoint, artifactId, fileUrl);

  // Log event
  queries.insertJobEvent(c.var.db, id, body.checkpoint, "checkpoint", `Checkpoint saved: ${body.checkpoint}`, null);

  // Broadcast
  c.var.eventBus.send({ type: "job_checkpoint", data: { job_id: id, checkpoint: body.checkpoint } });

  // Telegram notification
  const job = queries.getJob(c.var.db, id);
  const title = job?.title ?? "Unknown";
  sendNotification(c, { type: "CheckpointSaved", title, phase: body.checkpoint });

  return c.json({ ok: true });
}

export async function completeCallback(c: Context<AppBindings>): Promise<Response> {
  const id = c.req.param("id") as string;
  const body = await c.req.json<Record<string, any>>();
  const resolution = body.video_resolution || "1080p";
  const duration = body.duration_seconds ?? 0;

  console.log(`[callback] complete job=${id} resolution=${resolution} duration=${duration}`);

  try {
    // Get job before update to capture gh_run_id
    const job = queries.getJob(c.var.db, id);
    const ghRunId = job.ghRunId;

    queries.updateJobCompleted(c.var.db, id, resolution, duration);
    console.log(`[callback] job ${id} marked completed`);

    // Log event
    queries.insertJobEvent(c.var.db, id, null, "status_change", `Completed: ${resolution}, ${duration}s duration`, null);

    // Broadcast
    c.var.eventBus.send({ type: "job_completed", data: { job_id: id } });

    // Telegram notification
    const title = job?.title ?? "Unknown";
    sendNotification(c, { type: "JobCompleted", title, details: `${resolution}, ${duration}s duration` });

    // Clean up GHA run
    if (ghRunId) {
      const ghToken = queries.getSetting(c.var.db, "gh_token");
      const ghRepo = queries.getSetting(c.var.db, "gh_repo");
      if (ghToken && ghRepo) {
        const url = `https://api.github.com/repos/${ghRepo}/actions/runs/${ghRunId}`;
        fetch(url, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${ghToken}`,
            Accept: "application/vnd.github+json",
          },
        }).catch((e) => console.error(`[callback] GHA cleanup failed job=${id}:`, e));
      }
    }
  } catch (e: any) {
    console.error(`[callback] complete failed job=${id}:`, e);
    return c.json({ error: e.message || "Internal error" }, 500);
  }

  return c.json({ ok: true });
}

export async function failedCallback(c: Context<AppBindings>): Promise<Response> {
  const id = c.req.param("id") as string;
  const body = await c.req.json<Record<string, any>>();
  const errorMsg = body.error_message || "Unknown error";

  queries.updateJobFailed(c.var.db, id, errorMsg);

  // Log event
  queries.insertJobEvent(c.var.db, id, null, "error", `Failed: ${errorMsg}`, null);

  // Broadcast
  c.var.eventBus.send({ type: "job_failed", data: { job_id: id, error: errorMsg } });

  // Telegram notification
  const job = queries.getJob(c.var.db, id);
  const title = job?.title ?? "Unknown";
  const phase = job?.currentPhase ?? "unknown";
  sendNotification(c, { type: "JobFailed", title, phase, error: errorMsg });

  return c.json({ ok: true });
}
