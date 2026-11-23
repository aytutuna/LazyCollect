import { Hono } from "hono";
import { activity } from "./activity";
import { auth } from "./auth";
import { client } from "./client";
import { clients } from "./clients";
import { exportZip } from "./export";
import { files } from "./files";
import { firm, loadFirm } from "./firm";
import { purgeExpired } from "./purge";
import { requests } from "./requests";
import { retention } from "./retention";
import { runReminders } from "./reminders";
import { sweepFiles } from "./sweep";
import { templates } from "./templates";
import { trash } from "./trash";
import { unsubscribe } from "./unsubscribe";
import { uploads } from "./upload";
import { csrf } from "./csrf";
import { htmlHeaders } from "./headers";
import { DAY } from "./util";
import { loadSession, type AppEnv } from "./session";

const app = new Hono<AppEnv>();

app.onError((e, c) => {
  console.error(e instanceof Error ? e.message : "error");
  return c.json({ error: "server_error" }, 500);
});

app.use("/api/*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-store");
});
app.use("/api/*", csrf, loadSession);
app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", auth);
app.route("/api", client);
app.route("/api", uploads);
app.use("/api/firm", loadFirm);
app.use("/api/retention/*", loadFirm);
app.use("/api/retention", loadFirm);
app.use("/api/trash", loadFirm);
app.use("/api/activity", loadFirm);
app.use("/api/clients/*", loadFirm);
app.use("/api/templates/*", loadFirm);
app.use("/api/requests/*", loadFirm);
app.use("/api/files/*", loadFirm);
app.route("/api", firm);
app.route("/api", clients);
app.route("/api", templates);
app.route("/api", requests);
app.route("/api", exportZip);
app.route("/api", retention);
app.route("/api", trash);
app.route("/api", activity);
app.route("/api", files);

app.route("/u", unsubscribe);

app.get("/c/*", async (c) => {
  const page = await c.env.ASSETS.fetch(new URL("/c", c.req.url));
  const headers = new Headers(page.headers);
  for (const [name, value] of Object.entries({ ...htmlHeaders, "Cache-Control": "no-store" })) headers.set(name, value);
  return new Response(page.body, { status: page.status, headers });
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env) {
    const now = Date.now();
    // one failing step must not stop the others; only the message is logged
    const step = async (run: () => Promise<unknown>) => {
      try {
        await run();
      } catch (e) {
        console.error(e instanceof Error ? e.message : "error");
      }
    };
    await step(() =>
      env.CONTROL.batch([
        env.CONTROL.prepare("DELETE FROM login_codes WHERE created_at < ?").bind(now - DAY),
        env.CONTROL.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
      ]),
    );
    await step(() => sweepFiles(env, now));
    await step(() => purgeExpired(env, now));
    await step(() => runReminders(env, now));
  },
};
