import type { Context } from "hono";
import type { AppBindings } from "../app";
import { eq, and } from "drizzle-orm";
import { hlsChunks } from "../db/schema";
import { notFound } from "../error";
import * as queries from "../db/queries";

function resolveBaseUrl(c: Context<AppBindings>): string {
  const host = c.req.header("x-forwarded-host");
  const proto = c.req.header("x-forwarded-proto");
  if (host && proto) {
    return `${proto}://${host}`;
  }

  const requestHost = c.req.header("host");
  if (requestHost) {
    const scheme = proto === "https" ? "https" : "http";
    return `${scheme}://${requestHost}`;
  }

  const configUrl = c.var.config.publicBaseUrl;
  if (configUrl) return configUrl;

  return "http://localhost:8080";
}
function extractToken(c: Context<AppBindings>): string {
  const fromHeader = c.req.header("Authorization")?.startsWith("Bearer ")
    ? c.req.header("Authorization")!.slice(7)
    : undefined;
  return fromHeader || c.req.query("token") || "";
}

export async function playlistHandler(c: Context<AppBindings>) {
  const jobId = c.req.param("jobId")!;
  const token = extractToken(c);
  const qs = token ? `?token=${token}` : "";
  const allChunks = queries.getHlsChunks(c.var.db, jobId);
  const tsChunks = allChunks.filter((ch) => ch.filename.endsWith(".ts") && ch.discordUrl != null);

  if (tsChunks.length === 0) {
    throw notFound("No HLS segments found");
  }

  const baseUrl = resolveBaseUrl(c);
  const job = queries.getJob(c.var.db, jobId);

  // Collect valid per-chunk durations from DB.
  // ponytail: skip absurd values (<=0, >30) — they're parse artifacts.
  const chunkDurs: number[] = [];
  for (const chunk of tsChunks) {
    const raw = chunk.durationSeconds;
    if (raw != null && raw > 0 && raw <= 30) {
      chunkDurs.push(raw);
    }
  }

  // Compute avg from valid chunks, fallback to job total if available
  const sumValid = chunkDurs.reduce((s, d) => s + d, 0);
  const validCount = chunkDurs.length;
  const avgFromChunks = validCount > 0 ? sumValid / validCount : 1;
  const jobDur = job?.durationSeconds ?? 0;
  const avgDuration = jobDur > 0 ? jobDur / tsChunks.length : avgFromChunks;

  let maxDur = avgDuration;
  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];

  for (const chunk of tsChunks) {
    const raw = chunk.durationSeconds;
    const dur = (raw != null && raw > 0 && raw <= 30) ? raw : avgDuration;
    if (dur > maxDur) maxDur = dur;
    lines.push(`#EXTINF:${dur.toFixed(6)},`);
    lines.push(`${baseUrl}/proxy/hls/${jobId}/${chunk.filename}${qs}`);
  }

  const TARGET_DURATION = Math.max(Math.ceil(maxDur), 1);
  lines.splice(2, 0, `#EXT-X-TARGETDURATION:${TARGET_DURATION}`);

  lines.push("#EXT-X-ENDLIST");

  // ponytail: estimate total from chunk data when job duration missing
  const estimatedTotal = validCount > 0
    ? sumValid + avgDuration * (tsChunks.length - validCount)
    : avgDuration * tsChunks.length;

  return new Response(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store, must-revalidate",
      "Access-Control-Allow-Origin": "*",
      "X-Debug-Chunks": String(tsChunks.length),
      "X-Debug-ValidDurs": String(validCount),
      "X-Debug-AvgDuration": avgDuration.toFixed(3),
      "X-Debug-MaxDuration": maxDur.toFixed(3),
      "X-Debug-EstTotal": estimatedTotal.toFixed(1),
    },
  });
}

export async function chunkHandler(c: Context<AppBindings>) {
  const jobId = c.req.param("jobId")!;
  const filename = c.req.param("filename")!;

  const rows = c.var.db
    .select({ discordUrl: hlsChunks.discordUrl, discordMessageId: hlsChunks.discordMessageId })
    .from(hlsChunks)
    .where(and(eq(hlsChunks.jobId, jobId), eq(hlsChunks.filename, filename)))
    .all();

  const row = rows[0];
  if (!row?.discordUrl) {
    return c.json({ error: "segment not found" }, 404);
  }

  const storedUrl: string = row.discordUrl;
  const msgId = row.discordMessageId ?? null;

  const rangeHeader = c.req.header("range");
  const rangeValue = rangeHeader?.startsWith("bytes=") ? rangeHeader.slice(6) : undefined;

  const result = await tryFetchChunk(storedUrl, rangeValue);
  if (result) return result;

  // Try refreshing CDN URL
  const refreshUrl = await refreshDiscordUrl(c, jobId, msgId);
  if (refreshUrl) {
    const retry = await tryFetchChunk(refreshUrl, rangeValue);
    if (retry) {
      c.var.db
        .update(hlsChunks)
        .set({ discordUrl: refreshUrl })
        .where(and(eq(hlsChunks.jobId, jobId), eq(hlsChunks.filename, filename)))
        .run();
      return retry;
    }
  }

  console.log(`[proxy] all attempts failed for jobId=${jobId} filename=${filename}`);
  return c.json({ error: "segment unavailable", details: "Discord CDN URL expired and could not be refreshed" }, 502);
}

async function tryFetchChunk(
  url: string,
  range?: string,
): Promise<Response | null> {
  const headers: Record<string, string> = {};
  if (range) headers.Range = `bytes=${range}`;

  try {
    const resp = await fetch(url, { headers });
    const status = resp.status;

    if (status !== 200 && status !== 206) {
      console.log(`[proxy] fetch returned ${status} for ${url.slice(0, 80)}...`);
      return null;
    }

    const contentLength = resp.headers.get("content-length");
    const contentRange = resp.headers.get("content-range");

    const outHeaders: Record<string, string> = {
      "Content-Type": "video/mp2t",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Accept-Ranges": "bytes",
    };
    if (contentLength) outHeaders["Content-Length"] = contentLength;
    if (contentRange) outHeaders["Content-Range"] = contentRange;
    if (status === 206) {
      outHeaders["Cache-Control"] = "public, max-age=31536000";
    }

    return new Response(resp.body, { status, headers: outHeaders });
  } catch (e) {
    console.log(`[proxy] fetch error for chunk:`, e);
    return null;
  }
}

async function refreshDiscordUrl(
  c: Context<AppBindings>,
  jobId: string,
  msgId: string | null,
): Promise<string | null> {
  if (!msgId) {
    console.log(`[proxy] no discordMessageId for chunk`);
    return null;
  }

  const botToken = queries.getSetting(c.var.db, "discord_bot_token") || c.var.config.discordBotToken;
  if (!botToken) {
    console.log(`[proxy] no discord_bot_token configured`);
    return null;
  }

  // Get channel ID: job-specific first, then global setting
  const jobRow = queries.getJob(c.var.db, jobId);
  const channelId = jobRow?.discordChannelId || queries.getSetting(c.var.db, "discord_channel_id") || c.var.config.discordChannelId;
  if (!channelId) {
    console.log(`[proxy] no discord_channel_id configured`);
    return null;
  }

  try {
    const resp = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${msgId}`,
      { headers: { Authorization: `Bot ${botToken}` } },
    );
    if (!resp.ok) return null;

    const body = await resp.json() as Record<string, unknown>;
    const attachments = body.attachments as Array<Record<string, unknown>> | undefined;
    const url = attachments?.[0]?.url;
    if (typeof url !== "string") return null;
    return url;
  } catch (e) {
    console.log(`[proxy] fetch error for chunk:`, e);
    return null;
  }
}
