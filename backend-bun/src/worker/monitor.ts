import type { DrizzleDB } from "../db/index";
import type { EventBus } from "../api/events";
import {
  listJobsByStatuses,
  updateJobFailed,
  insertJobEvent,
} from "../db/queries";

const ACTIVE_STATUSES = [
  "processing",
  "downloading",
  "checkpoint_download",
  "transcoding",
  "checkpoint_transcode",
  "uploading",
];

/**
 * Recover jobs left in active states after a server restart.
 * Sets each to failed with a human-readable message so the user can retry.
 */
export function recoverStaleJobs(db: DrizzleDB, _eventBus?: EventBus): void {
  const staleJobs = listJobsByStatuses(db, ACTIVE_STATUSES);
  for (const job of staleJobs) {
    updateJobFailed(db, job.id, "Server restarted — job interrupted, please retry");
    insertJobEvent(
      db,
      job.id,
      null,
      "error",
      "Server restarted while job was in progress",
      null,
    );
  }
  console.log(`[monitor] Recovered ${staleJobs.length} stale job(s)`);
}
