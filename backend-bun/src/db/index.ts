import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

export type DrizzleDB = ReturnType<typeof drizzle>;

export function createDb(dbPath: string = "data/streamvault.db"): DrizzleDB {
  const sqliteDb = new Database(dbPath);
  sqliteDb.run("PRAGMA journal_mode=WAL");
  sqliteDb.run("PRAGMA foreign_keys=ON");

  const db = drizzle(sqliteDb, { schema });
  migrate(db, { migrationsFolder: "./migrations" });
  return db;
}
