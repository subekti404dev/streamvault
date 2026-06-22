import type { Context } from "hono";
import type { AppBindings } from "../app";
import { badRequest, notFound } from "../error";
import * as queries from "../db/queries";

interface SearchRequest {
  imdb_id: string;
  media_type: string;
  season?: number;
  episode?: number;
}

interface SearchResponse {
  meta: SearchMeta;
  torrents: TorrentEntry[];
}

interface SearchMeta {
  title: string;
  poster: string | null;
  year: number | null;
}

export interface TorrentEntry {
  name: string;
  title: string;
  filename: string;
  sizeBytes: number;
  infohash: string;
  magnetUri: string;
  fileIdx: number;
}

const LOW_QUALITY_KEYWORDS = [
  "cam", "screener", "3d", "ts", "tc", "hdcam", "hdts",
  "r5", "dvdscr", "hdscr", "telecine", "telesync", "hdtc",
  "dvdscreener", "bdscr", "ppv", "dvdrip", "vhsrip",
];

// ponytail: 10 trackers is plenty; Rust has 80+, we trim to essentials
const DEFAULT_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.moeking.me:6969/announce",
  "udp://explodie.org:6969/announce",
  "udp://exodus.desync.com:6969/announce",
  "http://tracker.opentrackr.org:1337/announce",
  "https://tracker.leechshield.link:443/announce",
  "https://tracker.gcrenwp.top:443/announce",
  "udp://p4p.arenabg.com:1337/announce",
  "udp://movies.zsw.ca:6969/announce",
  "udp://tracker.theoks.net:6969/announce",
  "https://tracker.bt4g.com:443/announce",
  "udp://tracker.ccp.ovh:6969/announce",
  "udp://tracker.auctor.tv:6969/announce",
];

function qualityScore(title: string): number {
  const lower = title.toLowerCase();
  if (lower.includes("2160p") || lower.includes("4k") || lower.includes("uhd")) return 50;
  if (lower.includes("1080p") || lower.includes("fhd")) return 40;
  if (lower.includes("720p") || lower.includes("hd")) return 30;
  if (lower.includes("480p") || lower.includes("sd")) return 20;
  return 10;
}

function isLowQuality(title: string): boolean {
  const compact = title.toLowerCase().replace(/\s+/g, "");
  return LOW_QUALITY_KEYWORDS.some((kw) => compact.includes(kw));
}

function filterTorrents(torrents: TorrentEntry[], limit: number): TorrentEntry[] {
  return torrents
    .filter((t) => !isLowQuality(t.title) && !isLowQuality(t.name))
    .sort((a, b) => {
      const sa = qualityScore(a.title);
      const sb = qualityScore(b.title);
      if (sb !== sa) return sb - sa;
      return b.sizeBytes - a.sizeBytes;
    })
    .slice(0, limit);
}

function buildMagnet(infohash: string, dn: string): string {
  const dnEncoded = encodeURIComponent(dn);
  const parts = [`xt=urn:btih:${infohash}`, `dn=${dnEncoded}`];
  for (const tr of DEFAULT_TRACKERS) {
    parts.push(`tr=${tr}`);
  }
  return `magnet:?${parts.join("&")}`;
}

function getSettingOrEnv(c: Context<AppBindings>, key: string): string | undefined {
  const fromDb = queries.getSetting(c.var.db, key);
  if (fromDb) return fromDb;
  const val = c.var.config[key as keyof typeof c.var.config];
  if (typeof val === "string") return val;
  return undefined;
}

interface CinemetaMeta {
  imdbId: string;
  mediaType: string;
  title: string | null;
  posterUrl: string | null;
  overview: string | null;
  year: number | null;
  totalSeasons: number | null;
}

async function fetchCinemeta(
  c: Context<AppBindings>,
  imdbId: string,
  mediaType: string,
): Promise<CinemetaMeta> {
  const cached = queries.getCachedMeta(c.var.db, imdbId, mediaType);
  if (cached) {
    return {
      imdbId: cached.imdbId,
      mediaType: cached.mediaType,
      title: cached.title,
      posterUrl: cached.posterUrl,
      overview: cached.overview,
      year: cached.year,
      totalSeasons: cached.totalSeasons,
    };
  }

  const url = `https://v3-cinemeta.strem.io/meta/${mediaType}/${imdbId}.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw notFound("Title not found in Cinemeta");
  const json = (await resp.json()) as Record<string, unknown>;
  const meta = json.meta as Record<string, unknown> | undefined;
  if (!meta) throw notFound("Title not found in Cinemeta");

  const record: CinemetaMeta = {
    imdbId,
    mediaType,
    title: typeof meta.name === "string" ? meta.name : null,
    posterUrl: typeof meta.poster === "string" ? meta.poster : null,
    overview: typeof meta.overview === "string" ? meta.overview : null,
    year: typeof meta.year === "number" ? meta.year : null,
    totalSeasons: typeof meta.totalSeasons === "number" ? meta.totalSeasons : null,
  };

  queries.upsertCachedMeta(c.var.db, {
    imdbId,
    mediaType,
    title: record.title,
    posterUrl: record.posterUrl,
    overview: record.overview,
    year: record.year,
    totalSeasons: record.totalSeasons,
  });

  return record;
}

interface TorrentioStream {
  infoHash?: string;
  name?: string;
  title?: string;
  size?: number;
  fileIdx?: number;
  behaviorHints?: { filename?: string };
}

async function searchTorrentio(
  c: Context<AppBindings>,
  mediaType: string,
  streamId: string,
): Promise<TorrentEntry[]> {
  const baseUrl = getSettingOrEnv(c, "torrentioBaseUrl") ?? "https://torrentio.strem.fun";
  const url = `${baseUrl}/stream/${mediaType}/${streamId}.json`;
  const resp = await fetch(url, { headers: { "User-Agent": "StreamVault/1.0" } });
  if (!resp.ok) return [];
  const json = (await resp.json()) as Record<string, unknown>;
  const streams = Array.isArray(json.streams) ? (json.streams as TorrentioStream[]) : [];

  const torrents: TorrentEntry[] = [];
  for (const stream of streams) {
    if (!stream.infoHash) continue;
    const name = stream.name ?? "Unknown";
    const title = stream.title ?? stream.infoHash;
    const filename = stream.behaviorHints?.filename ?? "";
    const sizeBytes = typeof stream.size === "number" ? stream.size : 0;
    const fileIdx = typeof stream.fileIdx === "number" ? stream.fileIdx : 0;

    torrents.push({
      name,
      title,
      filename,
      sizeBytes,
      infohash: stream.infoHash,
      magnetUri: buildMagnet(stream.infoHash, title),
      fileIdx,
    });
  }

  return torrents;
}

export async function searchHandler(c: Context<AppBindings>): Promise<Response> {
  const body = (await c.req.json()) as SearchRequest;

  if (!body.imdb_id?.startsWith("tt")) {
    throw badRequest("Invalid IMDB ID format");
  }

  const meta = await fetchCinemeta(c, body.imdb_id, body.media_type);

  const streamId =
    body.media_type === "series"
      ? `${body.imdb_id}:${body.season ?? 1}:${body.episode ?? 1}`
      : body.imdb_id;

  const torrents = await searchTorrentio(c, body.media_type, streamId);
  const filtered = filterTorrents(torrents, 5);

  return c.json({
    meta: {
      title: meta.title ?? body.imdb_id,
      poster: meta.posterUrl,
      year: meta.year,
    },
    torrents: filtered,
  } satisfies SearchResponse);
}
