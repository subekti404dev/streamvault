import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { AppError } from "./error";
import type { Config } from "./config";
import type { DrizzleDB } from "./db/index";
import type { EventBus } from "./api/events";

export interface AppBindings {
  Bindings: {};
  Variables: {
    config: Config;
    db: DrizzleDB;
    eventBus: EventBus;
  };
}

export function createApp(config: Config, db: DrizzleDB, eventBus: EventBus): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use("*", logger());
  app.use("*", cors({ origin: (origin) => origin, allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowHeaders: ["*"], credentials: true, maxAge: 86400 }));

  app.use("*", async (c, next) => {
    c.set("config", config);
    c.set("db", db);
    c.set("eventBus", eventBus);
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message }, err.statusCode as any);
    }
    console.error("Unhandled error:", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
