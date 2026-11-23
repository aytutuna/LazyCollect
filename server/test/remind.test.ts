import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MANUAL_SEQ } from "../src/mail";
import { DAY } from "../src/util";
import { api, inDays, mockOutbound, setup } from "./helpers";

const ADDRESS = "12 King St W\nToronto ON M5H 1A1";

async function ready(link = true) {
  const { cookie, client } = await setup();
  await api("/api/firm", { method: "PATCH", cookie, body: { address: ADDRESS, phone: "416-555-0100" } });
  await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
  const req = await (
    await api("/api/requests", {
      method: "POST",
      cookie,
      body: { client_id: client.id, title: "2025 taxes", deadline: inDays(10), items: [{ label: "Passport", required: true }, { label: "T4 slip", required: false }] },
    })
  ).json<any>();
  const made = link ? await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>() : null;
  return { cookie, client, req, url: made?.url as string };
}

const remind = (cookie: string, id: string) => api(`/api/requests/${id}/remind`, { method: "POST", cookie });
const messages = async () => (await env.DB_NA.prepare("SELECT * FROM messages ORDER BY sent_at, rowid").all<any>()).results;
const audits = async (action: string) => (await env.DB_NA.prepare("SELECT * FROM audit WHERE action = ?").bind(action).all<any>()).results;

describe("remind now", () => {
  it("emails the current link, keeps it working and logs the message and the audit row", async () => {
    const { cookie, req, url } = await ready();
    const sent = mockOutbound();
    const res = await remind(cookie, req.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["amy@mail.test"]);
    expect(sent[0].subject).toContain("Reminder: 2025 taxes");
    expect(sent[0].from).toBe('"Tuna Tax via Lazy Collect" <noreply@alazy.app>');
    expect(sent[0].reply_to).toBe("owner@firm.test");
    for (const part of [sent[0].text, sent[0].html]) {
      expect(part).toContain(url);
      expect(part).toContain("12 King St W");
      expect(part).toContain("Passport");
    }
    expect(sent[0].headers!["List-Unsubscribe"]).toMatch(/^<https:\/\/collect\.alazy\.app\/u\//);
    expect(sent[0].headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    const live = (await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM links WHERE revoked_at IS NULL").first<any>())!.n;
    expect(live).toBe(1);
    const [row] = await messages();
    expect(row).toMatchObject({ kind: "reminder", status: "sent", seq: MANUAL_SEQ });
    expect((await audits("reminder.send"))[0]).toMatchObject({ actor_type: "user", object_id: req.id });
  });

  it("does not disturb the cron's own cadence", async () => {
    const { cookie, req } = await ready();
    mockOutbound();
    const before = await env.DB_NA.prepare("SELECT reminder_seq, next_reminder_at FROM requests WHERE id = ?").bind(req.id).first<any>();
    await remind(cookie, req.id);
    expect(await env.DB_NA.prepare("SELECT reminder_seq, next_reminder_at FROM requests WHERE id = ?").bind(req.id).first<any>()).toEqual(before);
  });

  it("allows one a day per request and then again", async () => {
    const { cookie, req } = await ready();
    const sent = mockOutbound();
    await remind(cookie, req.id);
    const again = await remind(cookie, req.id);
    expect(again.status).toBe(429);
    const body = await again.json<any>();
    expect(body.error).toBe("too_soon");
    expect(body.next_at).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(sent).toHaveLength(1);
    await env.DB_NA.prepare("UPDATE messages SET sent_at = ?").bind(Date.now() - DAY - 1000).run();
    expect((await remind(cookie, req.id)).status).toBe(200);
    expect((await messages()).map((m) => m.seq)).toEqual([MANUAL_SEQ, MANUAL_SEQ + 1]);
  });

  it("lets two requests of one client each have their own", async () => {
    const { cookie, client, req } = await ready();
    const other = await (
      await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "Other", deadline: inDays(10), items: [{ label: "ID", required: true }] } })
    ).json<any>();
    await api(`/api/requests/${other.id}/link`, { method: "POST", cookie });
    mockOutbound();
    expect((await remind(cookie, req.id)).status).toBe(200);
    expect((await remind(cookie, other.id)).status).toBe(200);
  });

  it("does not let a failed send use up the day", async () => {
    const { cookie, req } = await ready();
    mockOutbound(true, false);
    expect((await remind(cookie, req.id)).status).toBe(502);
    mockOutbound();
    expect((await remind(cookie, req.id)).status).toBe(200);
  });

  it("counts against the account's daily cap and says so", async () => {
    const { cookie, req } = await ready();
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'trialing', trial_ends_at = ?, stripe_subscription_id = NULL").bind(inDays(5)).run();
    const firmId = (await env.CONTROL.prepare("SELECT id FROM firms").first<any>())!.id;
    await env.DB_NA.batch(
      Array.from({ length: 50 }, (_, i) =>
        env.DB_NA.prepare("INSERT INTO staff_mail (id, firm_id, sent_at) VALUES (?, ?, ?)").bind(`${i}`.padStart(32, "0"), firmId, Date.now()),
      ),
    );
    const sent = mockOutbound();
    const res = await remind(cookie, req.id);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "email_limit" });
    expect(sent).toHaveLength(0);
  });

  it("refuses without a live link and never makes one", async () => {
    const { cookie, req } = await ready(false);
    mockOutbound();
    expect(await (await remind(cookie, req.id)).json()).toEqual({ error: "not_open" });
    await api(`/api/requests/${req.id}/link`, { method: "POST", cookie });
    await env.DB_NA.prepare("UPDATE links SET revoked_at = 1").run();
    const res = await remind(cookie, req.id);
    expect([res.status, await res.json()]).toEqual([409, { error: "no_link" }]);
    await env.DB_NA.prepare("UPDATE links SET revoked_at = NULL, expires_at = 1").run();
    expect((await remind(cookie, req.id)).status).toBe(409);
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM links").first<any>())!.n).toBe(1);
  });

  it("refuses a request that is not open", async () => {
    const { cookie, req } = await ready();
    mockOutbound();
    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    const res = await remind(cookie, req.id);
    expect([res.status, await res.json()]).toEqual([409, { error: "not_open" }]);
    await env.DB_NA.prepare("UPDATE requests SET status = 'complete'").run();
    expect((await remind(cookie, req.id)).status).toBe(409);
  });

  it("refuses when nothing is missing", async () => {
    const { cookie, req } = await ready();
    mockOutbound();
    await env.DB_NA.prepare("UPDATE items SET status = 'approved'").run();
    expect(await (await remind(cookie, req.id)).json()).toEqual({ error: "nothing_missing" });
  });

  it("refuses a client without consented email or who has unsubscribed", async () => {
    const { cookie, client, req } = await ready();
    const sent = mockOutbound();
    await env.DB_NA.prepare("UPDATE clients SET email_ok_at = NULL").run();
    expect(await (await remind(cookie, req.id)).json()).toEqual({ error: "client_email_needed" });
    await env.DB_NA.prepare("UPDATE clients SET email_ok_at = 1, email = NULL").run();
    expect((await remind(cookie, req.id)).status).toBe(400);
    await env.DB_NA.prepare("UPDATE clients SET email = 'amy@mail.test', email_stop_at = 5").run();
    expect(await (await remind(cookie, req.id)).json()).toEqual({ error: "client_unsubscribed" });
    // a stop recorded for the address, whatever client row holds it now
    await env.DB_NA.prepare("UPDATE clients SET email_stop_at = NULL").run();
    const { stopHash } = await import("../src/mail");
    const firmId = (await env.CONTROL.prepare("SELECT id FROM firms").first<any>())!.id;
    await env.DB_NA.prepare("INSERT INTO email_stops (firm_id, email_hash, stopped_at) VALUES (?, ?, 1)").bind(firmId, await stopHash(env, "amy@mail.test")).run();
    expect(await (await remind(cookie, req.id)).json()).toEqual({ error: "client_unsubscribed" });
    await env.DB_NA.prepare("UPDATE clients SET deleted_at = 1 WHERE id = ?").bind(client.id).run();
    expect((await remind(cookie, req.id)).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("refuses an account without an address, or whose plan has lapsed", async () => {
    const { cookie, req } = await ready();
    const sent = mockOutbound();
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'canceled', trial_ends_at = 1").run();
    const lapsed = await remind(cookie, req.id);
    expect([lapsed.status, await lapsed.json()]).toEqual([402, { error: "plan" }]);
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active', address = NULL").run();
    expect(await (await remind(cookie, req.id)).json()).toEqual({ error: "address_needed" });
    expect(sent).toHaveLength(0);
  });

  it("is 404 for another account's request and needs a session", async () => {
    const { req } = await ready();
    const { cookie: other } = await setup("b@two.test");
    expect((await remind(other, req.id)).status).toBe(404);
    expect((await api(`/api/requests/${req.id}/remind`, { method: "POST" })).status).toBe(401);
  });

  it("flags hand-sent messages in the request's message list", async () => {
    const { cookie, req } = await ready();
    mockOutbound();
    await remind(cookie, req.id);
    const list = await (await api(`/api/requests/${req.id}/messages`, { cookie })).json<any[]>();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "reminder", status: "sent", manual: 1 });
  });
});

describe("showing the link again", () => {
  it("returns the live link and audits the look", async () => {
    const { cookie, req, url } = await ready();
    const res = await api(`/api/requests/${req.id}/link`, { cookie });
    expect(await res.json()).toMatchObject({ url });
    expect((await audits("link.view"))[0]).toMatchObject({ object_id: req.id, actor_type: "user" });
  });

  it("answers null once the link is replaced and shows the new one", async () => {
    const { cookie, req, url } = await ready();
    const fresh = await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>();
    expect((await (await api(`/api/requests/${req.id}/link`, { cookie })).json<any>()).url).toBe(fresh.url);
    expect(fresh.url).not.toBe(url);
    await env.DB_NA.prepare("UPDATE links SET revoked_at = 1").run();
    expect(await (await api(`/api/requests/${req.id}/link`, { cookie })).json()).toEqual({ url: null });
  });

  it("is 404 for another account's request", async () => {
    const { req } = await ready();
    const { cookie: other } = await setup("b@two.test");
    expect((await api(`/api/requests/${req.id}/link`, { cookie: other })).status).toBe(404);
  });
});
