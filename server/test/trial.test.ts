import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runTrialNotices } from "../src/trial";
import { DAY, HOUR } from "../src/util";
import { addMember, api, codeFrom, login, mockOutbound, start } from "./helpers";

const trialEnds = (at: number) => env.CONTROL.prepare("UPDATE firms SET trial_ends_at = ?").bind(at).run();
const notices = async () => (await env.CONTROL.prepare("SELECT kind FROM trial_notices ORDER BY kind").all<{ kind: string }>()).results.map((r) => r.kind);

async function signUp(email: string, sent: ReturnType<typeof mockOutbound>) {
  await start(email);
  return api("/api/auth/verify", { method: "POST", body: { email, code: codeFrom(sent[0]) } });
}

describe("trial emails", () => {
  it("welcomes a new account once, with the trial end and the subscribe link", async () => {
    const sent = mockOutbound();
    expect((await signUp("new@firm.test", sent)).status).toBe(200);
    const mails = sent.filter((m) => m.subject === "Your Lazy Collect trial has started");
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toEqual(["new@firm.test"]);
    expect(mails[0].text).toContain("https://collect.alazy.app/settings");
    expect(mails[0].text).toMatch(/runs until \w+ \d+, \d{4}/);
    // signing in again opens no new account
    sent.length = 0;
    await start("new@firm.test");
    await api("/api/auth/verify", { method: "POST", body: { email: "new@firm.test", code: codeFrom(sent[0]) } });
    expect(sent.filter((m) => m.subject.includes("trial"))).toHaveLength(0);
  });

  it("still signs the person in when the welcome email fails", async () => {
    const sent = mockOutbound();
    await start("new@firm.test");
    const code = codeFrom(sent[0]);
    mockOutbound(true, 400);
    const res = await api("/api/auth/verify", { method: "POST", body: { email: "new@firm.test", code } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("=");
  });

  it("sends the 3-days-before email to every owner, once", async () => {
    const cookie = await login("owner@firm.test");
    await addMember(cookie, "second@firm.test");
    await env.CONTROL.prepare("UPDATE users SET role = 'owner'").run();
    await env.CONTROL.prepare("DELETE FROM trial_notices").run();
    await trialEnds(Date.now() + 2.5 * DAY);
    const sent = mockOutbound();
    await runTrialNotices(env);
    expect(sent.map((m) => m.to[0]).sort()).toEqual(["owner@firm.test", "second@firm.test"]);
    expect(sent[0].subject).toMatch(/^Your Lazy Collect trial ends on /);
    expect(sent[0].text).toContain("https://collect.alazy.app/settings");
    expect(sent[0].text).toContain("new uploads from your clients pause");
    expect(sent[0].text).toContain("we will email you when you can subscribe");
    expect(sent[0].text).not.toMatch(/in 3 days|nothing changes|opened in full/);
    await runTrialNotices(env);
    await runTrialNotices(env);
    expect(sent).toHaveLength(2);
    expect(await notices()).toEqual(["soon", "soon"]);
  });

  it("waits until three days are left, and skips accounts that already pay", async () => {
    await login("owner@firm.test");
    const sent = mockOutbound();
    await trialEnds(Date.now() + 4 * DAY);
    await runTrialNotices(env);
    expect(sent).toHaveLength(0);
    await trialEnds(Date.now() + 2 * DAY);
    await env.CONTROL.prepare("UPDATE firms SET stripe_subscription_id = 'sub_1'").run();
    await runTrialNotices(env);
    expect(sent).toHaveLength(0);
  });

  it("sends the ended email once the trial is over, once, and not for old trials", async () => {
    await login("owner@firm.test");
    await env.CONTROL.prepare("DELETE FROM trial_notices").run();
    const sent = mockOutbound();
    await trialEnds(Date.now() - 10 * DAY);
    await runTrialNotices(env);
    expect(sent).toHaveLength(0);
    await trialEnds(Date.now() - HOUR);
    await runTrialNotices(env);
    await runTrialNotices(env);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("Your Lazy Collect trial has ended");
    expect(sent[0].text).toContain("New uploads from your clients are paused");
    expect(await notices()).toEqual(["end"]);
  });

  it("sends the 3-days email and then the ended email to the same account", async () => {
    await login("owner@firm.test");
    await env.CONTROL.prepare("DELETE FROM trial_notices").run();
    const sent = mockOutbound();
    await trialEnds(Date.now() + 2 * DAY);
    await runTrialNotices(env);
    await trialEnds(Date.now() - HOUR);
    await runTrialNotices(env);
    expect(sent.map((m) => m.subject.includes("ended"))).toEqual([false, true]);
  });

  it("sends the emails again for a trial that was changed", async () => {
    await login("owner@firm.test");
    await env.CONTROL.prepare("DELETE FROM trial_notices").run();
    await trialEnds(Date.now() + 2 * DAY);
    const sent = mockOutbound();
    await runTrialNotices(env);
    await runTrialNotices(env);
    expect(sent).toHaveLength(1);
    await trialEnds(Date.now() + 2.5 * DAY);
    await runTrialNotices(env);
    expect(sent).toHaveLength(2);
  });

  it("never sends the welcome email to an account that already exists", async () => {
    await login("owner@firm.test");
    await env.CONTROL.prepare("DELETE FROM trial_notices").run();
    const sent = mockOutbound();
    await runTrialNotices(env);
    expect(sent).toHaveLength(0);
  });

  it("gives the slot back when the provider is busy, and keeps it after a refusal", async () => {
    await login("owner@firm.test");
    await env.CONTROL.prepare("DELETE FROM trial_notices").run();
    await trialEnds(Date.now() + 2 * DAY);
    mockOutbound(true, 429);
    await runTrialNotices(env);
    expect(await notices()).toEqual([]);
    const sent = mockOutbound();
    await runTrialNotices(env);
    expect(sent).toHaveLength(1);
    await env.CONTROL.prepare("DELETE FROM trial_notices").run();
    mockOutbound(true, 400);
    await runTrialNotices(env);
    expect(await notices()).toEqual(["soon"]);
  });
});
