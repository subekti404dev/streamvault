export interface ProviderContext {
  mediaType: "movie" | "series";
  imdbId: string;
  title: string;
  year: number | null;
  season?: number;
  episode?: number;
}

export interface ProviderResult {
  infoHash: string;
  title: string;
  sizeBytes: number;
  seeders: number;
  provider: string;
}

export interface TorrentProvider {
  id: string;
  label: string;
  supports(mediaType: "movie" | "series"): boolean;
  search(ctx: ProviderContext): Promise<ProviderResult[]>;
}

export function parseSizeToBytes(size: string): number {
  const m = size.match(/([\d.]+)\s*(TB|GB|MB|KB|B)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const mult: Record<string, number> = { TB: 1024 ** 4, GB: 1024 ** 3, MB: 1024 ** 2, KB: 1024, B: 1 };
  return Math.round(n * (mult[unit] ?? 1));
}

/** All words longer than 3 chars from the query must appear in the candidate title */
export function titleWordsMatch(query: string, candidate: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[._\-[\]()':!?,]/g, " ").split(/\s+/).filter(Boolean);
  const qWords = norm(query).filter((w) => w.length > 3);
  if (qWords.length === 0) return true;
  const cTitle = norm(candidate).join(" ");
  return qWords.every((w) => cTitle.includes(w));
}

const EPISODE_RE = /[Ss](\d{1,2})[Ee](\d{1,3})|(\d{1,2})[Xx](\d{1,3})/;

/** Strict S/E match; allows full-season packs (S01 or S01E01-E99 ranges stay out for now) */
export function matchesEpisode(title: string, season: number, episode: number): boolean {
  const m = title.match(EPISODE_RE);
  if (!m) return false;
  const s = m[1] ? parseInt(m[1], 10) : m[3] ? parseInt(m[3], 10) : -1;
  const e = m[2] ? parseInt(m[2], 10) : m[4] ? parseInt(m[4], 10) : -1;
  return s === season && e === episode;
}
