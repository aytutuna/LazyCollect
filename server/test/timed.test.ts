import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ALERT_TO, lastGoodRun, runTimed, type Step } from "../src/timed";
import { HOUR, MINUTE } from "../src/util";
import { api, mockOutbound } from "./helpers";

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
    expect(sent[0].text).toContain("files: R2 is unreachable");
    const rows = await status();
    expect(rows.run).toBeUndefined();
    expect(rows.files).toMatchObject({ failed_at: now, error: "R2 is unreachable" });
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
    expect((await lastGoodRun(env, now + 20 * MINUTE)).last_good_run).toBe(now);
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
