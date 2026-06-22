import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite/driver";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

/** Concrete type from drizzle, not ReturnType */
export type DrizzleDB = BunSQLiteDatabase<typeof schema>;

/**
 * Parse `sqlite:/path/to/db?mode=rwc` → `/path/to/db`, or return as-is if plain path.
 */
function parseDbUrl(url: string): string {
  // strip sqlite: prefix
  const path = url.replace(/^sqlite:/, "");
  // strip query params
  return path.split("?")[0];
}

export function createDb(dbUrl: string = "sqlite:data/streamvault.db?mode=rwc"): DrizzleDB {
  const dbPath = parseDbUrl(dbUrl);
  const sqliteDb = new Database(dbPath);
  sqliteDb.run("PRAGMA journal_mode=WAL");
  sqliteDb.run("PRAGMA foreign_keys=ON");

  const db = drizzle(sqliteDb, { schema });
  migrate(db, { migrationsFolder: "./migrations" });
  return db;
}
