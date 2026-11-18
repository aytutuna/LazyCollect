import { Hono } from "hono";
import { auth } from "./auth";
import { csrf } from "./csrf";
import { DAY } from "./util";
import { loadSession, type AppEnv } from "./session";

const app = new Hono<AppEnv>();

app.onError((e, c) => {
  console.error(e instanceof Error ? e.message : "error");
  return c.json({ error: "server_error" }, 500);
});

app.use("/api/*", csrf, loadSession);
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", auth);

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env) {
    const now = Date.now();
    await env.CONTROL.batch([
      env.CONTROL.prepare("DELETE FROM login_codes WHERE created_at < ?").bind(now - DAY),
      env.CONTROL.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    ]);
  },
};
