import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./session";

export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("Origin");
    if (c.req.header("X-Collect") !== "1" || (origin && origin !== new URL(c.env.APP_URL).origin)) {
      return c.json({ error: "forbidden" }, 403);
    }
  }
  await next();
};
