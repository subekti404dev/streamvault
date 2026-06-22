import type { DrizzleDB } from "../db/index";
import type { EventBus } from "../api/events";
import type { Config } from "../config";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import {
  countJobsByStatuses,
  countJobsByStatus,
  getNextQueuedJob,
  updateJobStatus,
  insertJobEvent,
  updateJobFailed,
} from "../db/queries";
import { triggerPipeline } from "../pipeline/trigger";
import { sendNotification } from "../notifications/telegram";

const ACTIVE_STATUSES = [
  "processing",
  "downloading",
  "checkpoint_download",
  "transcoding",
  "checkpoint_transcode",
  "uploading",
];

const TICK_MS = 15_000;

function buildFakeContext(
  db: DrizzleDB,
  config: Config,
  eventBus: EventBus,
): Context<AppBindings> {
  // triggerPipeline only reads c.var.{db,config} via getSettingOrEnv / getDiscordChannel
  // Hono's Context is a class we can't construct outside the framework;
  // this minimal shape satisfies all internal access patterns.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return {
    var: { db, config, eventBus },
  } as unknown as Context<AppBindings>;
}

function broadcastQueueUpdate(db: DrizzleDB, eventBus: EventBus): void {
  const processing = countJobsByStatuses(db, ACTIVE_STATUSES);
  const queued = countJobsByStatus(db, "queued");
  eventBus.send({ type: "queue_update", data: { processing, queued } });
}

function computeMaxConcurrent(config: Config): number {
  let channelCount = 0;
  if (config.discordChannelIds) {
    channelCount = Math.max(
      0,
      config.discordChannelIds.split(",").length,
    );
  } else if (config.discordChannelId) {
    channelCount = 1;
  } else {
    channelCount = 1;
  }
  return Math.max(1, channelCount);
}

async function tick(
  db: DrizzleDB,
  config: Config,
  eventBus: EventBus,
): Promise<void> {
  const maxConcurrent = computeMaxConcurrent(config);
  const activeCount = countJobsByStatuses(db, ACTIVE_STATUSES);
  const slots = maxConcurrent - activeCount;

  if (slots <= 0) {
    broadcastQueueUpdate(db, eventBus);
    return;
  }

  for (let i = 0; i < slots; i++) {
    const job = getNextQueuedJob(db);
    if (!job) break;

    updateJobStatus(db, job.id, "processing");
    insertJobEvent(
      db,
      job.id,
      null,
      "status_change",
      "Pipeline started by scheduler",
      null,
    );
    eventBus.send({ type: "job_started", data: { job_id: job.id } });
    // ponytail: sendNotification is async; fire-and-forget is fine here
    sendNotification(null as unknown as Context<AppBindings>, {
      type: "JobStarted",
      title: job.title ?? "",
    }).catch(() => {});

    const ctx = buildFakeContext(db, config, eventBus);
    triggerPipeline(ctx, job, false, false).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      updateJobFailed(db, job.id, `Trigger failed: ${msg}`);
    });
  }

  broadcastQueueUpdate(db, eventBus);
}

/**
 * Start the scheduler loop. Returns a cleanup function to stop it.
 */
export function worker(
  db: DrizzleDB,
  config: Config,
  eventBus: EventBus,
): () => void {
  const timer = setInterval(() => {
    tick(db, config, eventBus).catch((e) => {
      console.error("[scheduler] tick error:", e);
    });
  }, TICK_MS);
  return () => clearInterval(timer);
}
