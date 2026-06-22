import { createMiddleware } from "hono/factory";
import type { AppBindings } from "../app";

export const authMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const headerToken = c.req.header("Authorization")?.startsWith("Bearer ")
    ? c.req.header("Authorization")!.slice(7)
    : undefined;
  const queryToken = c.req.query("token");
  const token = headerToken || queryToken;

  if (token !== c.var.config.authSecret) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

export const callbackAuthMiddleware = createMiddleware<AppBindings>(async (c, next) => {
  const token = c.req.header("X-Callback-Token");
  if (token !== c.var.config.authSecret) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});
