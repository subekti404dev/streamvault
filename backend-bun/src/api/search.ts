import { toSnake } from "../db/transform";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { badRequest, notFound } from "../error";
import * as queries from "../db/queries";
import { fetchTorrentMeta, analyzeTorrentSafety } from "./torrent";
import { aggregateProviders, builtinProviders } from "../providers";

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
  verified?: boolean;
}

const LOW_QUALITY_KEYWORDS = [
  "cam", "screener", "3d", "ts", "tc", "hdcam", "hdts",
  "r5", "dvdscr", "hdscr", "telecine", "telesync", "hdtc",
  "dvdscreener", "bdscr", "ppv", "dvdrip", "vhsrip",
];

// Full tracker list from Rust backend (ngosang/trackerslist)
const DEFAULT_TRACKERS: string[] = [
  // HTTP
  "http://tracker.opentrackr.org:1337/announce",
  "http://www.torrentsnipe.info:2701/announce",
  "http://www.genesis-sp.org:2710/announce",
  "http://tracker810.xyz:11450/announce",
  "http://tracker.xiaoduola.xyz:6969/announce",
  "http://tracker.waaa.moe:6969/announce",
  "http://tracker.vanitycore.co:6969/announce",
  "http://tracker.sbsub.com:2710/announce",
  "http://tracker.renfei.net:8080/announce",
  "http://tracker.qu.ax:6969/announce",
  "http://tracker.privateseedbox.xyz:2710/announce",
  "http://tracker.mywaifu.best:6969/announce",
  "http://tracker.moxing.party:6969/announce",
  "http://tracker.lintk.me:2710/announce",
  "http://tracker.dmcomic.org:2710/announce",
  "http://tracker.dhitechnical.com:6969/announce",
  "http://tracker.corpscorp.online:80/announce",
  "http://tracker.bz:80/announce",
  "http://tracker.bt4g.com:2095/announce",
  "http://tracker.bt-hash.com:80/announce",
  "http://tracker.bittor.pw:1337/announce",
  "http://tr.nyacat.pw:80/announce",
  "http://tr.kxmp.cf:80/announce",
  "http://tr.highstar.shop:80/announce",
  "http://torrent.hificode.in:6969/announce",
  "http://t.overflow.biz:6969/announce",
  "http://shubt.net:2710/announce",
  "http://share.hkg-fansub.info:80/announce.php",
  "http://seeders-paradise.org:80/announce",
  "http://retracker.spark-rostov.ru:80/announce",
  "http://open.trackerlist.xyz:80/announce",
  "http://jvavav.com:80/announce",
  "http://home.yxgz.club:6969/announce",
  "http://bvarf.tracker.sh:2086/announce",
  "http://buny.uk:6969/announce",
  "http://bt1.xxxxbt.cc:6969/announce",
  "http://bt.poletracker.org:2710/announce",
  "http://bittorrent-tracker.e-n-c-r-y-p-t.net:1337/announce",
  "http://aboutbeautifulgallopinghorsesinthegreenpasture.online:80/announce",
  "http://1337.abcvg.info:80/announce",
  "http://0123456789nonexistent.com:80/announce",
  "http://004430.xyz:80/announce",
  "http://tracker2.dler.org:80/announce",
  "http://tracker.zhuqiy.com:80/announce",
  "http://tracker.skyts.net:6969/announce",
  "http://tracker.dler.org:6969/announce",
  "http://tracker.dler.com:6969/announce",
  // HTTPS
  "https://tracker.yemekyedim.com:443/announce",
  "https://tracker.pmman.tech:443/announce",
  "https://tracker.nekomi.cn:443/announce",
  "https://tracker.leechshield.link:443/announce",
  "https://tracker.gcrenwp.top:443/announce",
  "https://tracker.bt4g.com:443/announce",
  "https://tracker.7471.top:443/announce",
  "https://tr.zukizuki.org:443/announce",
  "https://tr.nyacat.pw:443/announce",
  "https://torrents.tmtime.dev:443/announce",
  "https://shahidrazi.online:443/announce",
  "https://tracker.zhuqiy.com:443/announce",
  "https://t.213891.xyz:443/announce",
  "https://pybittrack.retiolus.net:443/announce",
  "https://open.ftorrent.com:443/announce",
  // UDP
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.moeking.me:6969/announce",
  "udp://explodie.org:6969/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker1.bt.moack.co.kr:80/announce",
  "udp://tracker.bitsearch.to:1337/announce",
  "udp://tracker-udp.gbitt.info:80/announce",
  "udp://p4p.arenabg.com:1337/announce",
  "udp://movies.zsw.ca:6969/announce",
  "udp://tracker.theoks.net:6969/announce",
  "udp://retracker.lanta-net.ru:2710/announce",
  "udp://retracker.netbynet.ru:2710/announce",
  "udp://opentracker.i2p.rocks:6969/announce",
  "udp://tracker.4.babico.name.tr:31337/announce",
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

export function buildMagnet(infohash: string, dn: string): string {
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
  // settings keys are snake_case, config fields are camelCase
  const camel = key.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase()) as keyof typeof c.var.config;
  const v2 = c.var.config[camel];
  return typeof v2 === "string" ? v2 : undefined;
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
  description?: string;
  size?: number;
  fileIdx?: number;
  behaviorHints?: { filename?: string; fileIdx?: number; videoSize?: number };
}

async function searchTorrentio(
  c: Context<AppBindings>,
  mediaType: string,
  streamId: string,
): Promise<TorrentEntry[]> {
  // External addon source (Torrentio/Comet) can be disabled entirely — results
  // then come only from built-in providers.
  const enabled = (getSettingOrEnv(c, "enable_external_streams") ?? "true") !== "false";
  if (!enabled) {
    console.log("[search] external stream source disabled, using local providers only");
    return [];
  }
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
    // Torrentio puts release info in `title`; Comet-style addons put it in
    // `description` (first line) and omit `size` in favour of videoSize.
    const title =
      stream.title
      ?? stream.description?.split("\n")[0]?.replace(/^📄\s*/, "").trim()
      ?? stream.infoHash;
    const filename = stream.behaviorHints?.filename ?? "";
    const sizeBytes =
      typeof stream.size === "number" ? stream.size :
      typeof stream.behaviorHints?.videoSize === "number" ? stream.behaviorHints.videoSize : 0;
    const fileIdx =
      typeof stream.behaviorHints?.fileIdx === "number" ? stream.behaviorHints.fileIdx :
      typeof stream.fileIdx === "number" ? stream.fileIdx : 0;

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

  // Local built-in providers (YTS/EZTV). Dedup against external results,
  // keeping the first occurrence (external wins on hash collision).
  const seen = new Set(torrents.map((t) => t.infohash.toLowerCase()));
  const providerResults = await aggregateProviders(builtinProviders, {
    mediaType: body.media_type === "series" ? "series" : "movie",
    imdbId: body.imdb_id,
    title: meta.title ?? "",
    year: meta.year,
    season: body.season,
    episode: body.episode,
  });
  for (const r of providerResults) {
    if (seen.has(r.infoHash)) continue;
    seen.add(r.infoHash);
    torrents.push({
      name: `[P2P] ${r.provider.toUpperCase()}`,
      title: r.title,
      filename: "",
      sizeBytes: r.sizeBytes,
      infohash: r.infoHash,
      magnetUri: buildMagnet(r.infoHash, r.title),
      fileIdx: 0,
    });
  }

  // Quality-sort a wider slice first, then drop verified-unsafe entries so
  // deeper healthy candidates can fill the final limit.
  const candidates = filterTorrents(torrents, VALIDATE_SLICE);
  const validated = await applyVerdicts(c, candidates);
  const filtered = validated.slice(0, SEARCH_LIMIT);

  return c.json(toSnake({
    meta: {
      title: meta.title ?? body.imdb_id,
      poster: meta.posterUrl,
      year: meta.year,
    },
    torrents: filtered,
  } satisfies SearchResponse));
}

const VALIDATE_SLICE = 12;
const SEARCH_LIMIT = 5;
const VALIDATE_TIMEOUT_MS = 7_000;

/**
 * Drop torrents whose real .torrent contents verify as unsafe (executables,
 * no media). Verdicts are cached per-infohash; unverifiable hashes (cache
 * miss at itorrents) are kept but flagged `verified: false`.
 */
async function applyVerdicts(
  c: Context<AppBindings>,
  torrents: TorrentEntry[],
): Promise<TorrentEntry[]> {
  if (torrents.length === 0) return torrents;

  const hashes = [...new Set(torrents.map((t) => t.infohash.toLowerCase()))];
  const verdicts = queries.getTorrentVerdicts(c.var.db, hashes);
  const missing = hashes.filter((h) => !verdicts.has(h));

  if (missing.length > 0) {
    const results = await Promise.allSettled(
      missing.map((ih) => fetchTorrentMeta(ih, VALIDATE_TIMEOUT_MS)),
    );
    results.forEach((res, i) => {
      if (res.status !== "fulfilled" || !res.value) return;
      const ih = missing[i];
      const safety = analyzeTorrentSafety(res.value.name, res.value.files);
      queries.upsertTorrentVerdict(c.var.db, {
        infohash: ih,
        verified: true,
        safe: safety.safe,
        reason: safety.reason ?? null,
        name: res.value.name,
        fileCount: res.value.files.length,
      });
      verdicts.set(ih, { verified: true, safe: safety.safe });
    });
  }

  return torrents.map((t) => {
    const v = verdicts.get(t.infohash.toLowerCase());
    return { ...t, verified: v ? v.verified : false };
  }).filter((t) => {
    const v = verdicts.get(t.infohash.toLowerCase());
    return !(v?.verified && !v.safe);
  });
}
