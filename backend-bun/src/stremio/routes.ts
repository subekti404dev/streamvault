import type { Context } from "hono";
import type { AppBindings } from "../app";
import * as queries from "../db/queries";

export async function manifestHandler(c: Context<AppBindings>) {
  return c.json({
    id: "com.streamvault.addon",
    version: "1.0.0",
    name: "StreamVault",
    description: "Personal media library powered by StreamVault",
    resources: ["catalog", "meta", "stream"],
    types: ["movie", "series"],
    catalogs: [
      { type: "movie", id: "streamvault-movies", name: "Movies" },
      { type: "series", id: "streamvault-series", name: "Series" },
    ],
    idPrefixes: ["tt"],
    behaviorHints: { configurable: false, configurationRequired: false },
  });
}

export async function catalogHandler(c: Context<AppBindings>) {
  const type_ = c.req.param("type") || "movie";
  const completed = queries.listJobsByStatus(c.var.db, "completed");

  const seen = new Set<string>();
  const metas = completed
    .filter((j) => j.mediaType === type_ && !seen.has(j.imdbId) && seen.add(j.imdbId))
    .map((j) => ({
      id: j.imdbId,
      type: j.mediaType,
      name: j.title || "Unknown",
      poster: j.posterUrl || undefined,
    }));

  return c.json({ metas });
}

export async function metaHandler(c: Context<AppBindings>) {
  const type = c.req.param("type");
  const imdbId = (c.req.param("imdbId") || "").replace(/\.json$/, "");

  const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;

  let resp: Response;
  try {
    resp = await fetch(url);
  } catch {
    return c.json({ error: "upstream unreachable" }, 502);
  }

  if (!resp.ok) {
    const body = await resp.text();
    return c.body(body, resp.status as any);
  }

  const body = await resp.json() as Record<string, unknown>;
  if (body.meta && typeof body.meta === "object") {
    (body.meta as Record<string, unknown>).streamVault = { available: true };
  }
  return c.json(body);
}

export async function streamHandler(c: Context<AppBindings>) {
  const id = (c.req.param("id") || "").replace(/\.json$/, "");
  const parts = id.split(":");
  const imdbId = parts[0];
  const season = parts.length >= 2 ? parseInt(parts[1], 10) : null;
  const episode = parts.length >= 3 ? parseInt(parts[2], 10) : null;

  // Find matching completed job
  let matched: queries.Job | undefined;

  if (season !== null && episode !== null) {
    matched = queries.listJobsByStatus(c.var.db, "completed").find(
      (j) => j.imdbId === imdbId && j.season === season && j.episode === episode
    );
  } else if (season !== null) {
    matched = queries.listJobsByStatus(c.var.db, "completed").find(
      (j) => j.imdbId === imdbId && j.season === season
    );
  } else {
    matched = queries.listJobsByStatus(c.var.db, "completed").find(
      (j) => j.imdbId === imdbId && j.season == null
    );
  }

  if (!matched) return c.json({ streams: [] });

  const baseUrl = c.var.config.publicBaseUrl;
  const resolution = matched.videoResolution || "HD";
  const desc = season !== null && episode !== null
    ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")} • ${resolution} • H.264 / AAC`
    : `${resolution} • H.264 / AAC`;

  return c.json({
    streams: [{
      name: `StreamVault\n${resolution} H.264`,
      url: `${baseUrl}/proxy/hls/${matched.id}/master.m3u8`,
      description: desc,
    }],
  });
}
