import type { ProviderContext, ProviderResult, TorrentProvider } from "./types";
import { parseSizeToBytes, titleWordsMatch } from "./types";

// Mirrors rotate frequently; first success is remembered for the process lifetime.
const MIRRORS = [
  "https://yts.mx",
  "https://yts.lt",
  "https://yts.zone",
];
let activeMirror: string | null = null;

interface YtsTorrent {
  hash?: string;
  quality?: string;
  size?: string;
  seeds?: number;
  peers?: number;
}

interface YtsMovie {
  imdb_code?: string;
  title?: string;
  title_english?: string;
  year?: number;
  torrents?: YtsTorrent[];
}

async function fetchMovies(query: string): Promise<YtsMovie[]> {
  const path = `/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=50&sort_by=seeds&order_by=desc`;
  // Try the last-known-good mirror first, but always fall back to the rest —
  // mirrors die often, so a sticky choice must never become a dead end.
  const candidates = activeMirror
    ? [activeMirror, ...MIRRORS.filter((m) => m !== activeMirror)]
    : MIRRORS;

  for (const base of candidates) {
    try {
      const resp = await fetch(base + path, { headers: { "User-Agent": "StreamVault/1.0" } });
      if (!resp.ok) continue;
      const json = (await resp.json()) as Record<string, unknown>;
      const data = json.data as Record<string, unknown> | undefined;
      if (Array.isArray(data?.movies)) {
        activeMirror = base;
        return data.movies as YtsMovie[];
      }
      // valid response but no results — still a working mirror
      activeMirror = base;
      return [];
    } catch {
      if (activeMirror === base) activeMirror = null;
    }
  }
  return [];
}

export const ytsProvider: TorrentProvider = {
  id: "yts",
  label: "YTS",
  supports(mediaType) {
    return mediaType === "movie";
  },

  async search(ctx: ProviderContext): Promise<ProviderResult[]> {
    if (!ctx.title) return [];
    const query = [ctx.title, ctx.year ?? ""].join(" ").trim();
    const movies = await fetchMovies(query);

    const results: ProviderResult[] = [];
    for (const movie of movies) {
      if (ctx.year && typeof movie.year === "number" && movie.year !== ctx.year) continue;
      const mTitle = movie.title_english || movie.title || "";
      if (!titleWordsMatch(ctx.title, mTitle)) continue;

      for (const t of movie.torrents ?? []) {
        if (!t.hash || !/^[a-f0-9]{40}$/i.test(t.hash)) continue;
        results.push({
          infoHash: t.hash.toLowerCase(),
          title: `${mTitle} ${movie.year ?? ""} ${t.quality ?? ""}`.replace(/\s+/g, " ").trim(),
          sizeBytes: parseSizeToBytes(t.size ?? ""),
          seeders: t.seeds ?? 0,
          provider: "yts",
        });
      }
    }
    return results;
  },
};
