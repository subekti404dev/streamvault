import type { ProviderContext, ProviderResult, TorrentProvider } from "./types";
import { matchesEpisode } from "./types";

const API = "https://eztvx.to/api/get-torrents";

interface EztvTorrent {
  hash?: string;
  title?: string;
  filename?: string;
  size_bytes?: number | string;
  seeds?: number | string;
  peers?: number | string;
  season_number?: number | string;
  episode_number?: number | string;
  imdb_id?: string;
}

function numericImdb(imdbId: string): string {
  return imdbId.replace(/^tt/i, "").replace(/^0+/, "");
}

const MAX_PAGES = 5;

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

export const eztvProvider: TorrentProvider = {
  id: "eztv",
  label: "EZTV",
  supports(mediaType) {
    return mediaType === "series";
  },

  async search(ctx: ProviderContext): Promise<ProviderResult[]> {
    const imdbNum = numericImdb(ctx.imdbId);
    if (!/^\d+$/.test(imdbNum)) return [];

    // API lists newest-first; older seasons live on deeper pages
    const results: ProviderResult[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${API}?imdb_id=${imdbNum}&limit=100&page=${page}`;
      let json: Record<string, unknown>;
      try {
        const resp = await fetch(url, { headers: { "User-Agent": "StreamVault/1.0" } });
        if (!resp.ok) throw new Error(`EZTV HTTP ${resp.status}`);
        json = (await resp.json()) as Record<string, unknown>;
      } catch (e) {
        console.warn(`[providers] eztv page ${page} failed:`, e instanceof Error ? e.message : e);
        break;
      }
      const torrents = (Array.isArray(json.torrents) ? json.torrents : []) as EztvTorrent[];
      if (torrents.length === 0) break;

      for (const t of torrents) {
        if (!t.hash || !/^[a-f0-9]{40}$/i.test(t.hash)) continue;
        if (t.imdb_id && numericImdb(`tt${t.imdb_id}`) !== imdbNum) continue;

        const title = t.title || t.filename || "";
        // Numeric S/E fields are often null — fall back to title regex
        if (ctx.season && ctx.episode) {
          const sNum = typeof t.season_number === "number" ? t.season_number : parseInt(String(t.season_number ?? ""), 10);
          const eNum = typeof t.episode_number === "number" ? t.episode_number : parseInt(String(t.episode_number ?? ""), 10);
          const byFields = sNum === ctx.season && eNum === ctx.episode;
          const inTitle = matchesEpisode(title, ctx.season, ctx.episode);
          if (!byFields && !inTitle) continue;
        }

        results.push({
          infoHash: t.hash.toLowerCase(),
          title,
          sizeBytes: toNum(t.size_bytes),
          seeders: toNum(t.seeds),
          provider: "eztv",
        });
      }
    }
    return results;
  },
};
