import type { Context } from "hono";
import type { AppBindings } from "../app";
import { eq, and } from "drizzle-orm";
import { hlsChunks } from "../db/schema";
import { notFound } from "../error";
import * as queries from "../db/queries";
import { getStorageTgCredential } from "../pipeline/trigger";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

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
  const tsChunks = allChunks.filter((ch) => ch.filename.endsWith(".ts") && (ch.discordUrl != null || ch.tgFileId != null));

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
    .select({
      discordUrl: hlsChunks.discordUrl,
      discordMessageId: hlsChunks.discordMessageId,
      tgFileId: hlsChunks.tgFileId,
      storageProvider: hlsChunks.storageProvider,
    })
    .from(hlsChunks)
    .where(and(eq(hlsChunks.jobId, jobId), eq(hlsChunks.filename, filename)))
    .all();

  const row = rows[0];
  if (!row) {
    return c.json({ error: "segment not found" }, 404);
  }

  const rangeHeader = c.req.header("range");
  const rangeValue = rangeHeader?.startsWith("bytes=") ? rangeHeader.slice(6) : undefined;

  // Serve from local VPS cache when possible — Telegram/Discord CDN is high
  // latency and doesn't support range well, so caching each segment locally
  // (with proper byte-range support) is what keeps ExoPlayer from rebuffering.
  const cacheFile = `${HLS_CACHE_DIR}/${jobId}/${encodeURIComponent(filename)}`;
  const cached = serveFromCache(cacheFile, rangeValue);
  if (cached) return cached;

  const buf = await fetchSegmentBytes(c, row, jobId, filename);
  if (!buf) {
    console.log(`[proxy] segment unavailable for jobId=${jobId} filename=${filename}`);
    return c.json({ error: "segment unavailable" }, 502);
  }

  try {
    mkdirSync(`${HLS_CACHE_DIR}/${jobId}`, { recursive: true });
    writeFileSync(cacheFile, buf);
  } catch (e) {
    console.log(`[proxy] cache write failed:`, e instanceof Error ? e.message : String(e));
  }
  return serveBytes(buf, rangeValue);
}

// In-flight dedupe so concurrent requests for the same segment don't each hit
// Telegram/Discord.
const IN_FLIGHT = new Map<string, Promise<Buffer | null>>();

async function fetchSegmentBytes(
  c: Context<AppBindings>,
  row: { discordUrl: string | null; discordMessageId: string | null; tgFileId: string | null; storageProvider: string | null },
  jobId: string,
  filename: string,
): Promise<Buffer | null> {
  const key = `${jobId}/${filename}`;
  const existing = IN_FLIGHT.get(key);
  if (existing) return existing;

  const p = (async (): Promise<Buffer | null> => {
    try {
      if (row.storageProvider === "telegram") {
        const fileId = row.tgFileId;
        if (!fileId) return null;
        const url = await resolveTgUrl(c, fileId);
        if (!url) return null;
        return await fetchFullBytes(url);
      }

      const storedUrl = row.discordUrl;
      if (!storedUrl) return null;
      let buf = await fetchFullBytes(storedUrl);
      if (buf) return buf;

      const refreshUrl = await refreshDiscordUrl(c, jobId, row.discordMessageId);
      if (refreshUrl) {
        buf = await fetchFullBytes(refreshUrl);
        if (buf) {
          c.var.db
            .update(hlsChunks)
            .set({ discordUrl: refreshUrl })
            .where(and(eq(hlsChunks.jobId, jobId), eq(hlsChunks.filename, filename)))
            .run();
        }
        return buf;
      }
      return null;
    } finally {
      IN_FLIGHT.delete(key);
    }
  })();

  IN_FLIGHT.set(key, p);
  return p;
}

function serveFromCache(path: string, range?: string): Response | null {
  if (!existsSync(path)) return null;
  try {
    return serveBytes(readFileSync(path), range);
  } catch {
    return null;
  }
}

function serveBytes(buf: Buffer, range?: string): Response {
  const total = buf.length;
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end) start = end;
    const slice = buf.subarray(start, end + 1);
    return new Response(new Uint8Array(slice), {
      status: 206,
      headers: segmentHeaders(total, slice.length, `bytes ${start}-${end}/${total}`),
    });
  }
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: segmentHeaders(total, total),
  });
}

function segmentHeaders(total: number, contentLength: number, contentRange?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "video/mp2t",
    "Accept-Ranges": "bytes",
    "Content-Length": String(contentLength),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "public, max-age=31536000",
  };
  if (contentRange) h["Content-Range"] = contentRange;
  return h;
}

async function fetchFullBytes(url: string): Promise<Buffer | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log(`[proxy] source fetch returned ${resp.status} for ${url.slice(0, 80)}...`);
      return null;
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  } catch (e) {
    console.log(`[proxy] source fetch error:`, e instanceof Error ? e.message : String(e));
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

// ── Telegram (Bot API) chunk proxy ─────────────────────────────────────
// getFile → direct download URL, valid ~1h. Cache URL briefly so range
// seeks on the same segment don't re-hit getFile.

// Locally cached HLS segments (served with range support) so playback doesn't
// re-fetch every segment from Telegram/Discord's high-latency CDNs.
const HLS_CACHE_DIR = "data/hls_cache";

const TG_URL_CACHE = new Map<string, { url: string; at: number }>();
const TG_CACHE_TTL_MS = 3000 * 1000; // ~50 min (Bot API URLs valid ~1h)
const TG_CACHE_MAX_ENTRIES = 512;

async function resolveTgUrl(c: Context<AppBindings>, fileId: string): Promise<string | null> {
  const cached = TG_URL_CACHE.get(fileId);
  if (cached && Date.now() - cached.at < TG_CACHE_TTL_MS) {
    return cached.url;
  }

  const botToken =
    queries.getSetting(c.var.db, "tg_storage_bot_token") ||
    c.var.config.tgStorageBotToken ||
    getStorageTgCredential(c, "tg_storage_bot_token") ||
    "";
  if (!botToken) {
    console.log("[proxy] telegram storage bot token not configured");
    return null;
  }

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
    if (!resp.ok) {
      console.log(`[proxy] telegram getFile returned ${resp.status}`);
      return null;
    }
    const body = await resp.json() as Record<string, unknown>;
    const result = body.result as Record<string, unknown> | undefined;
    const filePath = result?.file_path;
    if (typeof filePath !== "string") return null;

    const url = `https://api.telegram.org/file/bot${botToken}/${encodeURIComponent(filePath)}`;

    if (TG_URL_CACHE.size >= TG_CACHE_MAX_ENTRIES) {
      const oldest = TG_URL_CACHE.keys().next().value;
      if (oldest !== undefined) TG_URL_CACHE.delete(oldest);
    }
    TG_URL_CACHE.set(fileId, { url, at: Date.now() });

    return url;
  } catch (e) {
    console.log("[proxy] telegram getFile error:", e instanceof Error ? e.message : String(e));
    return null;
  }
}
