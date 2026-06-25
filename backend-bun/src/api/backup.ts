import { Context } from "hono";
import type { AppBindings } from "../app";
import { jobs, jobEvents, hlsChunks, cinemetaCache, appSettings } from "../db/schema";

interface Row {
  [key: string]: unknown;
}

interface ExportData {
  jobs: Row[];
  job_events: Row[];
  hls_chunks: Row[];
  cinemeta_cache: Row[];
  app_settings: Row[];
  exported_at: string;
}

function isRow(v: unknown): v is Row {
  return typeof v === "object" && v !== null;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((i) => typeof i === "string");
}

interface ImportPayload {
  jobs?: Row[];
  job_events?: Row[];
  hls_chunks?: Row[];
  cinemeta_cache?: Row[];
  app_settings?: Row[];
}

const TABLE_NAMES = ["jobs", "job_events", "hls_chunks", "cinemeta_cache", "app_settings"] as const;

function isImportPayload(body: unknown): body is ImportPayload {
  if (!isRow(body)) return false;
  for (const key of TABLE_NAMES) {
    if (key in body) {
      const v = body[key];
      if (!Array.isArray(v)) return false;
      if (!v.every((r) => isRow(r))) return false;
    }
  }
  return true;
}

export async function exportHandler(c: Context<AppBindings>) {
  const db = c.var.db;

  const data: ExportData = {
    jobs: db.select().from(jobs).all(),
    job_events: db.select().from(jobEvents).all(),
    hls_chunks: db.select().from(hlsChunks).all(),
    cinemeta_cache: db.select().from(cinemetaCache).all(),
    app_settings: db.select().from(appSettings).all(),
    exported_at: new Date().toISOString(),
  };

  return c.json(data);
}

export async function importHandler(c: Context<AppBindings>) {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!isImportPayload(body)) {
    return c.json({ error: "Invalid backup format" }, 400);
  }

  const db = c.var.db;
  const sqlite = db.$client;

  // ponytail: raw SQLite execute for bulk import — Drizzle's .values() doesn't
  // support typed array inserts for bun-sqlite. Using raw INSERT is simpler.
  // Upgrade: batch INSERT via Drizzle if they add array support.
  sqlite.run("BEGIN TRANSACTION");
  try {
    // Delete in FK order: children first
    sqlite.run("DELETE FROM hls_chunks");
    sqlite.run("DELETE FROM job_events");
    sqlite.run("DELETE FROM jobs");
    sqlite.run("DELETE FROM cinemeta_cache");
    sqlite.run("DELETE FROM app_settings");

    // Insert from backup
    for (const [table, rows] of Object.entries(body) as [string, Row[]][]) {
      if (rows.length === 0) continue;

      const columns = Object.keys(rows[0]);
      const placeholders = columns.map(() => "?").join(", ");
      const quoted = columns.map((c) => `"${c}"`).join(", ");
      const stmt = sqlite.prepare(`INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})`);

      for (const row of rows) {
        const values: unknown[] = columns.map((c) => row[c] ?? null);
        // ponytail: sqlite accepts string|number|null — cast is safe at runtime
        (stmt.run as (...args: unknown[]) => void)(...values);
      }
    }

    sqlite.run("COMMIT");
  } catch (err) {
    sqlite.run("ROLLBACK");
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Import failed: ${msg}` }, 500);
  }

  const counts = {
    jobs: body.jobs?.length ?? 0,
    job_events: body.job_events?.length ?? 0,
    hls_chunks: body.hls_chunks?.length ?? 0,
    cinemeta_cache: body.cinemeta_cache?.length ?? 0,
    app_settings: body.app_settings?.length ?? 0,
  };

  return c.json({ ok: true, imported: counts });
}
