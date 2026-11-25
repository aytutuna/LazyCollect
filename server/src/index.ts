import { Hono } from "hono";
import { account, purgeClosed } from "./account";
import { activity } from "./activity";
import { native } from "./app";
import { auth } from "./auth";
import { batches, runBatches } from "./batches";
import { billing, stripeWebhook } from "./billing";
import { answers } from "./answers";
import { client } from "./client";
import { clients } from "./clients";
import { devices } from "./devices";
import { examples } from "./examples";
import { exportZip } from "./export";
import { dates } from "./expiry";
import { files } from "./files";
import { firm, loadClosedFirm, loadFirm } from "./firm";
import { importer } from "./import";
import { fingerprint, keyCheckGate, linkCheck, masterCheck, sameText } from "./keycheck";
import { passkeys } from "./passkeys";
import { people } from "./people";
import { notes } from "./notes";
import { pending } from "./pending";
import { purgeExpired } from "./purge";
import { remind } from "./remind";
import { repeat } from "./repeat";
import { requests } from "./requests";
import { retention } from "./retention";
import { runReminders } from "./reminders";
import { staff } from "./staff";
import { sweepFiles } from "./sweep";
import { templates } from "./templates";
import { trash } from "./trash";
import { runTrialNotices } from "./trial";
import { unavailable } from "./unavailable";
import { unsubscribe } from "./unsubscribe";
import { uploads } from "./upload";
import { csrf } from "./csrf";
import { htmlHeaders } from "./headers";
import { DAY } from "./util";
import { loadSession, type AppEnv } from "./session";
import { wellKnown } from "./wellknown";

const app = new Hono<AppEnv>();

app.onError((e, c) => {
  console.error(e instanceof Error ? e.message : "error");
  return c.json({ error: "server_error" }, 500);
});

app.use("/api/*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});
// Stripe's calls carry no cookie or X-Collect header, so this goes in before the csrf check and is verified by its signature
app.route("/api", stripeWebhook);
app.use("/api/*", csrf, loadSession);
app.get("/api/health", (c) => c.json({ ok: true, commit: c.env.COMMIT ?? null }));
app.get("/api/health/keys", async (c) => {
  if (!sameText(c.req.header("X-Key-Check") ?? "", await keyCheckGate(c.env))) return c.json({ error: "not_found" }, 404);
  return c.json({ master: await masterCheck(c.env), masterFingerprint: await fingerprint(c.env.MASTER_KEY_NA), link: await linkCheck(c.env) });
});
app.route("/api", auth);
app.route("/api", native);
app.route("/api", pending);
app.route("/api", client);
app.route("/api", uploads);
app.route("/api", answers);
app.route("/api", dates);
app.use("/api/firm", loadFirm);
app.use("/api/billing/*", loadFirm);
app.use("/api/account/close", loadClosedFirm);
app.use("/api/account/reopen", loadClosedFirm);
app.use("/api/retention/*", loadFirm);
app.use("/api/trash", loadFirm);
app.use("/api/staff/*", loadFirm);
app.use("/api/sessions/*", loadFirm);
app.use("/api/passkeys/*", loadFirm);
app.use("/api/security/*", loadFirm);
app.use("/api/activity", loadFirm);
app.use("/api/clients/*", loadFirm);
app.use("/api/batches/*", loadFirm);
app.use("/api/templates/*", loadFirm);
app.use("/api/requests/*", loadFirm);
app.use("/api/files/*", loadFirm);
app.use("/api/examples/*", loadFirm);
app.route("/api", firm);
app.route("/api", billing);
app.route("/api", account);
app.route("/api", clients);
app.route("/api", importer);
app.route("/api", templates);
app.route("/api", requests);
app.route("/api", people);
app.route("/api", batches);
app.route("/api", repeat);
app.route("/api", unavailable);
app.route("/api", notes);
app.route("/api", remind);
app.route("/api", exportZip);
app.route("/api", retention);
app.route("/api", trash);
app.route("/api", staff);
app.route("/api", devices);
app.route("/api", passkeys);
app.route("/api", activity);
app.route("/api", files);
app.route("/api", examples);

app.route("/u", unsubscribe);

app.route("/", wellKnown);

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
        env.CONTROL.prepare("DELETE FROM client_sessions WHERE expires_at < ?").bind(now),
        env.CONTROL.prepare("DELETE FROM app_challenges WHERE expires_at < ?").bind(now),
        env.CONTROL.prepare("DELETE FROM pending_logins WHERE expires_at < ?").bind(now),
        env.CONTROL.prepare("DELETE FROM passkey_challenges WHERE expires_at < ?").bind(now),
        env.CONTROL.prepare("DELETE FROM stripe_events WHERE received_at < ?").bind(now - 30 * DAY),
      ]),
    );
    await step(() => sweepFiles(env, now));
    await step(() => purgeExpired(env, now));
    await step(() => purgeClosed(env, now));
    await step(() => runBatches(env, now));
    await step(() => runReminders(env, now));
    await step(() => runTrialNotices(env, now));
  },
};
