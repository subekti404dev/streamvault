import { toSnake } from "../db/transform";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { notFound } from "../error";
import * as queries from "../db/queries";

export async function listLibrary(c: Context<AppBindings>) {
  const { db } = c.var;
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = Math.min(100, parseInt(c.req.query("limit") || "20", 10));
  const mediaType = c.req.query("type") || null;

  const result = queries.getCompletedJobsGrouped(db, mediaType, page, limit);
  return c.json(toSnake(result));
}

export async function requeueJobHandler(c: Context<AppBindings>) {
  const { db } = c.var;
  const jobId = c.req.param("jobId")!;

  const ok = queries.requeueJob(db, jobId);
  if (!ok) throw notFound("Job not found");

  return c.json({ job_id: jobId, status: "queued" });
}

export async function getLibraryItem(c: Context<AppBindings>) {
  const { db } = c.var;
  const imdbId = c.req.param("imdbId")!;

  const detail = queries.getLibraryDetail(db, imdbId);
  return c.json(toSnake(detail));
}

export async function deleteLibraryItem(c: Context<AppBindings>) {
  const { db } = c.var;
  const imdbId = c.req.param("imdbId")!;

  const count = queries.deleteJobsByImdbId(db, imdbId);
  if (count === 0) throw notFound("No completed jobs for " + imdbId);

  return c.json({ deleted: count });
}
