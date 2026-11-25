import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runReminders } from "../src/reminders";
import { atHour } from "../src/tz";
import { DAY } from "../src/util";
import { api, inDays, mockOutbound, setup } from "./helpers";

const SECRET = `whsec_${btoa("test-webhook-secret-bytes")}`;
const ADDRESS = "12 King St W\nToronto ON M5H 1A1";

beforeEach(() => {
  env.RESEND_WEBHOOK_SECRET = SECRET;
});

async function ready() {
  const { cookie, client } = await setup();
  await api("/api/firm", { method: "PATCH", cookie, body: { address: ADDRESS, phone: "416-555-0100" } });
  await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
  const req = await (
    await api("/api/requests", {
      method: "POST",
      cookie,
      body: { client_id: client.id, title: "2025 taxes", deadline: inDays(10), items: [{ label: "Passport", required: true }] },
    })
  ).json<any>();
  await api(`/api/requests/${req.id}/link`, { method: "POST", cookie });
  return { cookie, client, req };
}

async function sign(body: string, secret = SECRET, at = Date.now(), id = "msg_1") {
  const stamp = String(Math.floor(at / 1000));
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(secret.slice(6)), (c) => c.charCodeAt(0)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${stamp}.${body}`)));
  return { "svix-id": id, "svix-timestamp": stamp, "svix-signature": `v1,${btoa(String.fromCharCode(...mac))}` };
}

async function notice(event: object, headers?: Record<string, string>) {
  const body = JSON.stringify(event);
  return exports.default.fetch("https://collect.alazy.app/api/resend/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers ?? (await sign(body))) },
    body,
  });
}

const bounced = (to = "amy@mail.test", type = "Permanent") => ({ type: "email.bounced", data: { email_id: "email_1", to: [to], bounce: { type } } });
const client = () => env.DB_NA.prepare("SELECT email_bounced_at FROM clients").first<{ email_bounced_at: number | null }>();
const message = () => env.DB_NA.prepare("SELECT bounced_at FROM messages").first<{ bounced_at: number | null }>();

describe("bounced emails", () => {
  it("marks the message and the client when an address is refused for good", async () => {
    const { cookie, req } = await ready();
    mockOutbound();
    expect((await api(`/api/requests/${req.id}/remind`, { method: "POST", cookie })).status).toBe(200);
    expect((await message())!.bounced_at).toBeNull();

    expect((await notice(bounced())).status).toBe(200);
    expect((await message())!.bounced_at).toBeGreaterThan(0);
    expect((await client())!.email_bounced_at).toBeGreaterThan(0);

    const listed = await (await api("/api/clients", { cookie })).json<any>();
    expect((listed.items ?? listed)[0].email_bounced_at).toBeGreaterThan(0);
    const shown = await (await api(`/api/requests/${req.id}/messages`, { cookie })).json<any>();
    expect(shown[0].bounced_at).toBeGreaterThan(0);
  });

  it("stops reminders to that address, by hand and from the timed run", async () => {
    const { cookie, req } = await ready();
    mockOutbound();
    await api(`/api/requests/${req.id}/remind`, { method: "POST", cookie });
    await notice(bounced());

    const sent = mockOutbound();
    const again = await api(`/api/requests/${req.id}/remind`, { method: "POST", cookie });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "client_bounced" });
    // a Tuesday morning in the account's hours, long after the manual reminder
    const morning = atHour({ y: 2027, m: 1, d: 5 }, 10, "America/Toronto");
    await env.DB_NA.batch([
      env.DB_NA.prepare("UPDATE requests SET deadline = ?, next_reminder_at = ?, reminder_seq = 0").bind(morning + 15 * DAY, morning),
      env.DB_NA.prepare("UPDATE links SET expires_at = ?").bind(morning + 60 * DAY),
    ]);
    await runReminders(env, morning + 5 * 60_000);
    expect(sent).toHaveLength(0);

    // the same run sends once the mark is gone
    await env.DB_NA.prepare("UPDATE clients SET email_bounced_at = NULL").run();
    await env.DB_NA.prepare("UPDATE requests SET next_reminder_at = ?").bind(morning).run();
    await runReminders(env, morning + 5 * 60_000);
    expect(sent).toHaveLength(1);
  });

  it("takes the mark off when the address is changed, so reminders can go again", async () => {
    const { cookie, client: amy, req } = await ready();
    mockOutbound();
    await api(`/api/requests/${req.id}/remind`, { method: "POST", cookie });
    await notice(bounced());
    expect((await client())!.email_bounced_at).not.toBeNull();

    expect((await api(`/api/clients/${amy.id}`, { method: "PATCH", cookie, body: { email: "amy@other.test", contact_ok: true } })).status).toBe(200);
    expect((await client())!.email_bounced_at).toBeNull();
    await env.DB_NA.prepare("UPDATE messages SET sent_at = sent_at - ?").bind(3 * DAY).run();
    const sent = mockOutbound();
    expect((await api(`/api/requests/${req.id}/remind`, { method: "POST", cookie })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("leaves a client alone whose address was changed since the email went out", async () => {
    const { cookie, client: amy, req } = await ready();
    mockOutbound();
    await api(`/api/requests/${req.id}/remind`, { method: "POST", cookie });
    await api(`/api/clients/${amy.id}`, { method: "PATCH", cookie, body: { email: "amy@other.test", contact_ok: true } });
    await notice(bounced("amy@mail.test"));
    expect((await message())!.bounced_at).not.toBeNull();
    expect((await client())!.email_bounced_at).toBeNull();
  });

  it("ignores soft bounces, other events and emails it does not know", async () => {
    const { cookie, req } = await ready();
    mockOutbound();
    await api(`/api/requests/${req.id}/remind`, { method: "POST", cookie });
    expect((await notice(bounced("amy@mail.test", "Transient"))).status).toBe(200);
    expect((await notice({ type: "email.delivered", data: { email_id: "email_1", to: ["amy@mail.test"] } })).status).toBe(200);
    expect((await message())!.bounced_at).toBeNull();
    expect((await client())!.email_bounced_at).toBeNull();
  });

  it("asks for the notice again when no message has that id yet", async () => {
    await ready();
    expect((await notice({ type: "email.bounced", data: { email_id: "email_unknown", to: ["amy@mail.test"], bounce: { type: "Permanent" } } })).status).toBe(404);
  });

  it("never marks a client in another account, even with the same address", async () => {
    const a = await ready();
    mockOutbound();
    await api(`/api/requests/${a.req.id}/remind`, { method: "POST", cookie: a.cookie });
    await env.DB_NA.prepare("UPDATE messages SET provider_id = 'email_a'").run();

    const { cookie, client: other } = await setup("owner2@firm.test");
    await api("/api/firm", { method: "PATCH", cookie, body: { address: ADDRESS, phone: "416-555-0100" } });
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active' WHERE id = (SELECT firm_id FROM users WHERE email = 'owner2@firm.test')").run();
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: other.id, title: "Other", deadline: inDays(10), items: [{ label: "Passport", required: true }] } })).json<any>();
    await api(`/api/requests/${req.id}/link`, { method: "POST", cookie });
    mockOutbound();
    expect((await api(`/api/requests/${req.id}/remind`, { method: "POST", cookie })).status).toBe(200);
    await env.DB_NA.prepare("UPDATE messages SET provider_id = 'email_b' WHERE provider_id IS NOT 'email_a'").run();

    expect((await notice({ type: "email.bounced", data: { email_id: "email_a", to: ["amy@mail.test"], bounce: { type: "Permanent" } } })).status).toBe(200);
    const rows = (await env.DB_NA.prepare("SELECT firm_id, email_bounced_at FROM clients").all<any>()).results;
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.email_bounced_at)).toHaveLength(1);
    const marked = rows.find((r) => r.email_bounced_at)!;
    expect(marked.firm_id).toBe((await env.DB_NA.prepare("SELECT firm_id FROM messages WHERE provider_id = 'email_a'").first<any>())!.firm_id);
  });

  it("lets the person clear the mark and try the address again", async () => {
    const { cookie, client: amy, req } = await ready();
    mockOutbound();
    await api(`/api/requests/${req.id}/remind`, { method: "POST", cookie });
    await notice(bounced());
    expect((await api(`/api/clients/${amy.id}/retry-email`, { method: "POST", cookie })).status).toBe(200);
    expect((await client())!.email_bounced_at).toBeNull();
    expect((await api(`/api/clients/${amy.id}/retry-email`, { method: "POST", cookie })).status).toBe(404);
  });

  it("refuses a notice that is unsigned, mis-signed, stale or made with another secret", async () => {
    const body = JSON.stringify(bounced());
    expect((await notice(bounced(), {})).status).toBe(400);
    expect((await notice(bounced(), { ...(await sign(body)), "svix-signature": "v1,AAAA" })).status).toBe(400);
    expect((await notice(bounced(), await sign(body, SECRET, Date.now() - 10 * 60_000))).status).toBe(400);
    expect((await notice(bounced(), await sign(body, `whsec_${btoa("another-secret")}`))).status).toBe(400);
  });

  it("answers 503 until the signing secret is set", async () => {
    delete env.RESEND_WEBHOOK_SECRET;
    expect((await notice(bounced())).status).toBe(503);
  });
});
