import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { itemFailed } from "../src/pulse";
import { runReminders } from "../src/reminders";
import { atHour } from "../src/tz";
import { ALERT_TO, lastGoodRun, runTimed, type Step } from "../src/timed";
import { HOUR, MINUTE } from "../src/util";
import { vi } from "vitest";
import { api, inDays, mockOutbound, setup } from "./helpers";

const ok: Step = ["ok", async () => {}];
const broken: Step = ["files", async () => { throw new Error("R2 is unreachable"); }];
const status = async () => Object.fromEntries((await env.CONTROL.prepare("SELECT * FROM timed_status").all<any>()).results.map((r) => [r.step, r]));

describe("timed run watch", () => {
  it("records a good pass and answers with its age", async () => {
    const sent = mockOutbound();
    const now = Date.now();
    await runTimed(env, now, [ok]);
    expect(sent).toHaveLength(0);
    expect((await status()).run.ok_at).toBe(now);
    expect(await lastGoodRun(env, now + 12 * MINUTE)).toEqual({ last_good_run: now, age_minutes: 12 });
    const res = await api("/api/health/timed");
    expect(res.status).toBe(200);
    expect(await res.json<any>()).toMatchObject({ ok: true, last_good_run: expect.any(Number) });
  });

  it("runs a slower step once its last good run is old enough, and records only the steps that ran", async () => {
    const ran: string[] = [];
    const every10: Step = ["slow", async () => void ran.push("slow"), 10];
    const each: Step = ["fast", async () => void ran.push("fast")];
    const t = Date.now();
    await runTimed(env, t, [every10, each]);
    await runTimed(env, t + 3 * MINUTE, [every10, each]);
    expect(ran).toEqual(["slow", "fast", "fast"]);
    expect((await status()).slow.ok_at).toBe(t);
    // a run that was missed does not leave the step waiting for the next tenth minute
    await runTimed(env, t + 13 * MINUTE, [every10, each]);
    expect(ran).toEqual(["slow", "fast", "fast", "slow", "fast"]);
  });

  it("calls the pass as old as its slowest step, so the watch sees housekeeping that stopped", async () => {
    const t = Date.now();
    const slow: Step = ["slow", async () => {}, 10];
    await runTimed(env, t, [slow]);
    await runTimed(env, t + 40 * MINUTE, [["fast", async () => {}]]);
    expect(await lastGoodRun(env, t + 41 * MINUTE, [slow])).toEqual({ last_good_run: t, age_minutes: 41 });
  });

  it("does nothing while the last run is still working, and takes over from one that died", async () => {
    const ran: string[] = [];
    const step: Step = ["step", async () => void ran.push("ran")];
    const now = Date.now();
    await env.CONTROL.prepare("INSERT INTO timed_status (step, ok_at) VALUES ('lock', ?)").bind(now - 2 * MINUTE).run();
    await runTimed(env, now, [step]);
    expect(ran).toEqual([]);
    await env.CONTROL.prepare("UPDATE timed_status SET ok_at = ? WHERE step = 'lock'").bind(now - 11 * MINUTE).run();
    await runTimed(env, now, [step]);
    expect(ran).toEqual(["ran"]);
    // finished, so the next run is not held back
    await runTimed(env, now + MINUTE, [step]);
    expect(ran).toEqual(["ran", "ran"]);
  });

  it("has no good pass to name before the first one", async () => {
    expect(await lastGoodRun(env)).toEqual({ last_good_run: null, age_minutes: null });
  });

  it("emails support when a step fails, runs the others, and does not count the pass as good", async () => {
    const sent = mockOutbound();
    const now = Date.now();
    const ran: string[] = [];
    await runTimed(env, now, [broken, ["after", async () => void ran.push("after")]]);
    expect(ran).toEqual(["after"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([ALERT_TO]);
    expect(sent[0].subject).toBe("Lazy Collect: timed run failed (files)");
    expect(sent[0].text).toContain("files: Error");
    expect(sent[0].text).not.toContain("R2 is unreachable");
    const rows = await status();
    expect(rows.run).toBeUndefined();
    expect(rows.files).toMatchObject({ failed_at: now, error: "Error" });
    expect(rows.after.ok_at).toBe(now);
  });

  it("mails about the same failing step once an hour", async () => {
    const sent = mockOutbound();
    const now = Date.now();
    await runTimed(env, now, [broken]);
    await runTimed(env, now + 10 * MINUTE, [broken]);
    await runTimed(env, now + 50 * MINUTE, [broken]);
    expect(sent).toHaveLength(1);
    await runTimed(env, now + HOUR, [broken]);
    expect(sent).toHaveLength(2);
  });

  it("keeps the last good time when a later pass fails", async () => {
    mockOutbound();
    const now = Date.now();
    await runTimed(env, now, [ok]);
    await runTimed(env, now + 10 * MINUTE, [broken]);
    expect((await lastGoodRun(env, now + 20 * MINUTE, [ok])).last_good_run).toBe(now);
  });

  it("mails again when a step fails after it has recovered", async () => {
    const sent = mockOutbound();
    const now = Date.now();
    await runTimed(env, now, [broken]);
    // a step that is good again for a minute and fails again is the same trouble, mailed once an hour
    await runTimed(env, now + 10 * MINUTE, [["files", async () => {}]]);
    expect((await status()).files.alerted_at).not.toBeNull();
    await runTimed(env, now + 20 * MINUTE, [broken]);
    expect(sent).toHaveLength(1);
    // one that has been good for the hour is mailed about afresh
    await runTimed(env, now + 90 * MINUTE, [["files", async () => {}]]);
    expect((await status()).files.alerted_at).toBeNull();
    await runTimed(env, now + 100 * MINUTE, [broken]);
    expect(sent).toHaveLength(2);
  });

  it("keeps a run of put-off emails from looking like a good pass, so an outage trips the watch and a blip clears", async () => {
    const t = Date.now();
    await runTimed(env, t - MINUTE, [ok]);
    const outage: Step = ["reminders", async (_e, now) => { if (Math.round((now - t) / MINUTE) % 15 === 0) itemFailed("EmailDeferred"); }];
    mockOutbound();
    for (let m = 0; m <= 60; m++) await runTimed(env, t + m * MINUTE, [outage]);
    expect((await lastGoodRun(env, t + 60 * MINUTE, [outage])).age_minutes).toBeGreaterThan(30);

    await env.CONTROL.prepare("DELETE FROM timed_status").run();
    await runTimed(env, t - MINUTE, [ok]);
    const blip: Step = ["reminders", async (_e, now) => { if (now === t) itemFailed("EmailDeferred"); }];
    for (let m = 0; m <= 30; m++) await runTimed(env, t + m * MINUTE, [blip]);
    expect((await lastGoodRun(env, t + 30 * MINUTE, [blip])).age_minutes).toBeLessThan(5);
  });

  it("counts single items that fail inside a step that goes on", async () => {
    const sent = mockOutbound();
    const now = Date.now();
    const flaky: Step = ["reminders", async () => { itemFailed("EmailDeferred"); itemFailed("EmailDeferred"); itemFailed("TypeError"); }];
    await runTimed(env, now, [flaky]);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("reminders: EmailDeferred x2, TypeError x1");
    expect((await status()).run).toBeUndefined();
  });

  it("raises the alarm when the mail provider is down for the reminders, without a client address in it", async () => {
    const { cookie, client } = await setup();
    await api("/api/firm", { method: "PATCH", cookie, body: { address: "12 King St W\nToronto ON M5H 1A1" } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "2025 taxes", deadline: inDays(10), items: [{ label: "Passport", required: true }] } })).json<any>();
    await api(`/api/requests/${req.id}/link`, { method: "POST", cookie });
    const morning = atHour({ y: 2027, m: 1, d: 5 }, 10, "America/Toronto");
    await env.DB_NA.batch([
      env.DB_NA.prepare("UPDATE requests SET deadline = ?, next_reminder_at = ?, reminder_seq = 0").bind(morning + 15 * 86_400_000, morning),
      env.DB_NA.prepare("UPDATE links SET expires_at = ?").bind(morning + 60 * 86_400_000),
    ]);
    const alerts: any[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.to.includes(ALERT_TO)) {
        alerts.push(body);
        return Response.json({ id: "alert_1" });
      }
      return new Response("busy", { status: 503 });
    });
    await runTimed(env, morning + 5 * MINUTE, [["reminders", runReminders]]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toMatch(/reminders: EmailDeferred x\d/);
    expect(alerts[0].text).not.toContain("amy@mail.test");
    expect((await lastGoodRun(env, morning)).last_good_run).toBeNull();
  });

  it("clears the watch once a message put off for a day is given up on", async () => {
    const { cookie, client } = await setup();
    await api("/api/firm", { method: "PATCH", cookie, body: { address: "12 King St W\nToronto ON M5H 1A1" } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "2025 taxes", deadline: inDays(10), items: [{ label: "Passport", required: true }] } })).json<any>();
    await api(`/api/requests/${req.id}/link`, { method: "POST", cookie });
    const morning = atHour({ y: 2027, m: 1, d: 5 }, 10, "America/Toronto");
    await env.DB_NA.batch([
      env.DB_NA.prepare("UPDATE requests SET deadline = ?, next_reminder_at = ?, reminder_seq = 0").bind(morning + 15 * 86_400_000, morning),
      env.DB_NA.prepare("UPDATE links SET expires_at = ?").bind(morning + 60 * 86_400_000),
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_i, init) => (JSON.parse(String(init?.body)).to.includes(ALERT_TO) ? Response.json({ id: "a" }) : new Response("busy", { status: 503 })));
    const reminders: Step[] = [["reminders", runReminders]];
    await runTimed(env, morning + 5 * MINUTE, reminders);
    await runTimed(env, morning + 24 * HOUR - 10 * MINUTE, reminders);
    expect((await lastGoodRun(env, morning)).last_good_run).toBeNull();
    // past the day the message is given up on; that pass reports it, and the ones after it are clean
    await runTimed(env, morning + 24 * HOUR + 10 * MINUTE, reminders);
    const good = morning + 24 * HOUR + 12 * MINUTE;
    await runTimed(env, good, reminders);
    expect((await lastGoodRun(env, good)).last_good_run).toBe(good);
  });

  it("still finishes when the alert email cannot be sent", async () => {
    mockOutbound(true, 400);
    await expect(runTimed(env, Date.now(), [broken, ok])).resolves.toBeUndefined();
  });

  it("runs the real steps without a failure on an empty database", async () => {
    const sent = mockOutbound();
    await runTimed(env);
    expect(sent).toHaveLength(0);
    expect((await lastGoodRun(env)).last_good_run).not.toBeNull();
  });
});
