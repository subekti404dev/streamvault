import type { Context } from "hono";
import type { AppBindings } from "../app";
import type { Job } from "../db/queries";
import { badRequest } from "../error";
import { eq } from "drizzle-orm";
import { jobs } from "../db/schema";
import * as queries from "../db/queries";
import { pickChannel } from "./channel";

const WORKFLOW_FILE = "streamvault-pipeline.yml";

function configValue(config: AppBindings["Variables"]["config"], key: string): string | undefined {
  switch (key) {
    case "gh_token": return config.ghToken;
    case "gh_repo": return config.ghRepo;
    case "discord_bot_token": return config.discordBotToken;
    case "discord_channel_id": return config.discordChannelId;
    case "discord_channel_ids": return config.discordChannelIds;
    case "telegram_bot_token": return config.telegramBotToken;
    case "telegram_channel_id": return config.telegramChannelId;
    case "torrentio_base_url": return config.torrentioBaseUrl;
    default: return undefined;
  }
}

function getSettingOrEnv(c: Context<AppBindings>, key: string): string | undefined {
  const dbVal = queries.getSetting(c.var.db, key);
  if (dbVal) return dbVal;
  return configValue(c.var.config, key);
}

async function fetchGhRunId(
  ghToken: string,
  ghRepo: string,
  workflowFile: string,
): Promise<string | undefined> {
  const url =
    `https://api.github.com/repos/${ghRepo}/actions/workflows/${workflowFile}/runs` +
    `?status=in_progress&status=queued&per_page=5`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "StreamVault/1.0",
    },
  });
  if (!resp.ok) return undefined;
  const json: unknown = await resp.json();
  if (
    !json || typeof json !== "object" || !("workflow_runs" in json)
  ) return undefined;
  const runs = (json as Record<string, unknown>).workflow_runs;
  if (!Array.isArray(runs) || runs.length === 0) return undefined;
  const first = runs[0];
  if (!first || typeof first !== "object" || !("id" in first)) return undefined;
  const id = (first as Record<string, unknown>).id;
  return typeof id === "number" ? String(id) : undefined;
}

async function cancelGhRun(
  ghToken: string,
  ghRepo: string,
  runId: string,
): Promise<void> {
  const url =
    `https://api.github.com/repos/${ghRepo}/actions/runs/${runId}/cancel`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "StreamVault/1.0",
    },
  });
  if (!resp.ok && resp.status !== 204) {
    const text = await resp.text().catch(() => "");
    console.error(`cancel GH run failed (${resp.status}): ${text}`);
  }
}

async function getDiscordChannel(
  c: Context<AppBindings>,
  jobId: string,
): Promise<string> {
  const multi = getSettingOrEnv(c, "discord_channel_ids");
  if (multi) {
    const channels = multi.split(",").map((s) => s.trim()).filter(Boolean);
    if (channels.length > 0) {
      const picked = pickChannel(jobId, channels);
      if (picked !== null) return picked;
    }
  }
  const single = getSettingOrEnv(c, "discord_channel_id");
  if (single) return single;
  throw badRequest("No Discord channel configured");
}

async function triggerPipeline(
  c: Context<AppBindings>,
  job: Job,
  skipDownload: boolean,
  skipTranscode: boolean,
): Promise<string> {
  const ghToken = getSettingOrEnv(c, "gh_token");
  if (!ghToken) throw badRequest("GitHub token not configured");
  const ghRepo = getSettingOrEnv(c, "gh_repo");
  if (!ghRepo) throw badRequest("GitHub repo not configured");

  const baseUrl = c.var.config.publicBaseUrl;
  const callbackToken = c.var.config.authSecret;
  const discordChannel = await getDiscordChannel(c, job.id);
  const discordToken = getSettingOrEnv(c, "discord_bot_token") || "";

  const url =
    `https://api.github.com/repos/${ghRepo}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const body = {
    ref: "main",
    inputs: {
      job_id: job.id,
      magnet_uri: job.magnetUri ?? "",
      file_idx: String(job.fileIdx ?? 0),
      torrent_name: job.torrentName ?? "",
      callback_url: baseUrl,
      callback_token: callbackToken,
      discord_bot_token: discordToken,
      discord_channel_id: discordChannel,
      skip_download: String(skipDownload),
      skip_transcode: String(skipTranscode),
      checkpoint_dl_url: job.ghArtifactDlUrl ?? "",
      checkpoint_tc_url: job.ghArtifactTcUrl ?? "",
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "StreamVault/1.0",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw badRequest(`GitHub API error (${resp.status}): ${text}`);
  }

  // GitHub creates run asynchronously; wait then poll
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 3000);
  await promise;

  const ghRunId =
    (await fetchGhRunId(ghToken, ghRepo, WORKFLOW_FILE)) ?? "pending";

  queries.updateJobGhRun(c.var.db, job.id, ghRunId);
  c.var.db
    .update(jobs)
    .set({ discordChannelId: discordChannel })
    .where(eq(jobs.id, job.id))
    .run();
  queries.insertJobEvent(
    c.var.db,
    job.id,
    null,
    "status_change",
    `Pipeline triggered (run_id: ${ghRunId}, channel: ${discordChannel})`,
    null,
  );

  return ghRunId;
}

export { triggerPipeline, cancelGhRun };
