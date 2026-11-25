import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { DAY, HOUR } from "../src/util";
import { api, openRequest, pdf, upload } from "./helpers";

const trialEnds = (at: number) => env.CONTROL.prepare("UPDATE firms SET trial_ends_at = ?").bind(at).run();
const lapse = () => trialEnds(Date.now() - HOUR);

it("tells the client page that new files are paused once the trial has ended", async () => {
  const { path } = await openRequest();
  expect((await (await api(path)).json<any>()).paused).toBe(false);
  await lapse();
  const view = await (await api(path)).json<any>();
  expect(view.paused).toBe(true);
  expect(view.firm_name).toBe("Tuna Tax");
});

it("refuses an upload, and takes uploads again after a payment or a fresh trial", async () => {
  const { req, path } = await openRequest();
  const item = req.items[0].id;
  await lapse();
  const refused = await upload(path, item, pdf(400));
  expect(refused.status).toBe(402);
  expect(await refused.json()).toEqual({ error: "paused" });
  expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM files").first<{ n: number }>())!.n).toBe(0);

  await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
  expect((await upload(path, item, pdf(400))).status).toBe(201);
  await env.CONTROL.prepare("UPDATE firms SET plan_status = 'trialing', trial_ends_at = ?").bind(Date.now() - HOUR).run();
  expect((await upload(path, item, pdf(400))).status).toBe(402);
  await trialEnds(Date.now() + 14 * DAY);
  expect((await upload(path, item, pdf(400))).status).toBe(201);
});

it("keeps taking uploads from an account that has subscribed while its trial turns into a plan", async () => {
  const { req, path } = await openRequest();
  const item = req.items[0].id;
  await env.CONTROL.prepare("UPDATE firms SET stripe_subscription_id = 'sub_1', plan_status = 'trialing', trial_ends_at = ?").bind(Date.now() - HOUR).run();
  expect((await upload(path, item, pdf(400))).status).toBe(201);
  expect((await (await api(path)).json<any>()).paused).toBe(false);
  await trialEnds(Date.now() - 8 * DAY);
  expect((await upload(path, item, pdf(400))).status).toBe(402);
});

it("answers an upload that already arrived, and still takes messages", async () => {
  const { req, path } = await openRequest();
  const item = req.items[0].id;
  const uploadId = crypto.randomUUID();
  expect((await upload(path, item, pdf(400), { uploadId })).status).toBe(201);
  await lapse();
  expect((await upload(path, item, pdf(400), { uploadId })).status).toBe(200);
  const note = await api(`${path}/notes`, { method: "POST", body: { body: "Question about the passport" } });
  expect(note.status).toBe(201);
});
