import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeClosed } from "../src/account";
import { DAY, HOUR } from "../src/util";
import { addMember, api, codeFrom, cookieFrom, firmRow, login, mockOutbound, openRequest, setup, start } from "./helpers";

const OWNER = "owner@firm.test";
const NEWBIE = "newbie@mail.test";
const NONE = "0".repeat(32);

const invite = (cookie: string, email: string | number = NEWBIE, extra: object = {}) =>
  api("/api/staff/invites", { method: "POST", cookie, body: { email, ...extra } });
const list = async (cookie: string) => (await api("/api/staff", { cookie })).json<{ people: any[]; invites: any[] }>();
const me = async (cookie: string) => (await api("/api/me", { cookie })).json<any>();
const row = <T = any>(sql: string, ...binds: unknown[]) => env.CONTROL.prepare(sql).bind(...binds).first<T>();
const staffMail = async () => (await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM staff_mail").first<{ n: number }>())!.n;
const actions = async () => (await env.DB_NA.prepare("SELECT action FROM audit WHERE action LIKE 'invite.%' OR action LIKE 'staff.%' ORDER BY at, id").all<{ action: string }>()).results.map((r) => r.action);

// fills the account's staff_mail as if that many invites went out an hour ago
const fillStaffMail = (firmId: string, n: number) =>
  env.DB_NA.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})
     INSERT INTO staff_mail (id, firm_id, sent_at) SELECT lower(hex(randomblob(16))), ?, ? FROM n`,
  )
    .bind(firmId, Date.now() - HOUR)
    .run();

describe("invite and join", () => {
  it("lets the invited address sign in as a member of the inviting account", async () => {
    const { cookie } = await setup();
    const sent = mockOutbound();
    const res = await invite(cookie, "  Newbie@Mail.test ", { name: "Nina" });
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([NEWBIE]);
    expect(sent[0].subject).toBe("owner@firm.test invited you to Tuna Tax on Lazy Collect");
    expect(sent[0].text).toContain("https://collect.alazy.app/");
    expect(sent[0].text).toContain("expires in 7 days");
    expect(sent[0].headers).toBeUndefined();
    expect(sent[0].html).not.toContain("nsubscribe");

    const who = await me(await login(NEWBIE));
    expect(who.user.role).toBe("member");
    expect(who.user.name).toBe("Nina");
    expect(who.firm.id).toBe((await me(cookie)).firm.id);
    expect((await env.CONTROL.prepare("SELECT COUNT(*) AS n FROM firms").first<any>())!.n).toBe(1);
    expect((await row("SELECT accepted_at FROM invites"))!.accepted_at).not.toBeNull();
    expect(await actions()).toEqual(expect.arrayContaining(["invite.send", "invite.accept"]));

    const seen = await list(cookie);
    expect(seen.people.map((p) => [p.email, p.role])).toEqual([[OWNER, "owner"], [NEWBIE, "member"]]);
    expect(seen.invites).toEqual([]);
  });

  it("joins through the magic link too", async () => {
    const { cookie } = await setup();
    mockOutbound();
    await invite(cookie);
    const sent = mockOutbound();
    await start(NEWBIE);
    const t = sent[0].text.match(/link\?t=(\S+)/)![1];
    const res = await api("/api/auth/link", { method: "POST", body: { t } });
    expect(res.status).toBe(200);
    expect((await me(cookieFrom(res))).user.role).toBe("member");
  });

  it("still gives a non-invited address its own account", async () => {
    const { cookie } = await setup();
    mockOutbound();
    await invite(cookie);
    const who = await me(await login("other@mail.test"));
    expect(who.user.role).toBe("owner");
    expect(who.firm.id).not.toBe((await me(cookie)).firm.id);
  });

  it("ignores an expired or revoked invite", async () => {
    const { cookie } = await setup();
    mockOutbound();
    const late = await (await invite(cookie, "late@mail.test")).json<any>();
    const gone = await (await invite(cookie, "gone@mail.test")).json<any>();
    await env.CONTROL.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, late.id).run();
    expect((await api(`/api/staff/invites/${gone.id}`, { method: "DELETE", cookie })).status).toBe(200);
    const firm = (await me(cookie)).firm.id;
    for (const email of ["late@mail.test", "gone@mail.test"]) {
      const who = await me(await login(email));
      expect(who.user.role).toBe("owner");
      expect(who.firm.id).not.toBe(firm);
    }
  });

  it("takes the newest of several live invites", async () => {
    const { cookie } = await setup();
    const second = await setup("second@firm.test", "Second Firm");
    mockOutbound();
    await invite(cookie);
    await new Promise((r) => setTimeout(r, 5));
    await invite(second.cookie);
    expect((await me(await login(NEWBIE))).firm.name).toBe("Second Firm");
  });

  it("does not join a closed account", async () => {
    const { cookie } = await setup();
    mockOutbound();
    await invite(cookie);
    await api("/api/account/close", { method: "POST", cookie, body: { confirm: "Tuna Tax" } });
    expect((await me(await login(NEWBIE))).user.role).toBe("owner");
  });
});

describe("invite refusals", () => {
  it("answers already_has_account for any existing user", async () => {
    const { cookie } = await setup();
    await setup("elsewhere@firm.test", "Elsewhere");
    mockOutbound();
    for (const email of [OWNER, "elsewhere@firm.test"]) {
      const res = await invite(cookie, email);
      expect(res.status).toBe(409);
      expect((await res.json<any>()).error).toBe("already_has_account");
    }
  });

  it("refuses a second live invite for the same address and renews an expired one", async () => {
    const { cookie } = await setup();
    mockOutbound();
    expect((await invite(cookie)).status).toBe(201);
    const again = await invite(cookie);
    expect(again.status).toBe(409);
    expect((await again.json<any>()).error).toBe("already_invited");
    await env.CONTROL.prepare("UPDATE invites SET expires_at = ?").bind(Date.now() - 1).run();
    expect((await invite(cookie)).status).toBe(201);
    expect((await list(cookie)).invites).toHaveLength(1);
  });

  it("rejects a bad address, a long name and an account with no name", async () => {
    const { cookie } = await setup();
    mockOutbound();
    expect((await invite(cookie, "nope")).status).toBe(400);
    expect((await invite(cookie, 5)).status).toBe(400);
    expect((await invite(cookie, NEWBIE, { name: "x".repeat(121) })).status).toBe(400);
    const bare = await setup("bare@firm.test", null);
    expect((await invite(bare.cookie)).status).toBe(400);
  });

  it("stops at 100 people and live invites together", async () => {
    const { cookie } = await setup();
    const fid = (await me(cookie)).firm.id;
    await env.CONTROL.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 98)
       INSERT INTO users (id, firm_id, email, role, created_at) SELECT lower(hex(randomblob(16))), ?, 'm' || i || '@x.test', 'member', 1 FROM n`,
    )
      .bind(fid)
      .run();
    mockOutbound();
    expect((await invite(cookie)).status).toBe(201);
    const res = await invite(cookie, "one-more@mail.test");
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error).toBe("too_many_staff");
  });

  it("keeps an expired invite from coming back over the 100 cap", async () => {
    const { cookie } = await setup();
    mockOutbound();
    const { id } = await (await invite(cookie)).json<any>();
    await env.CONTROL.prepare("UPDATE invites SET expires_at = ?").bind(Date.now() - 1).run();
    await env.CONTROL.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
       INSERT INTO users (id, firm_id, email, role, created_at) SELECT lower(hex(randomblob(16))), ?, 'm' || i || '@x.test', 'member', 1 FROM n`,
    )
      .bind((await me(cookie)).firm.id)
      .run();
    const res = await api(`/api/staff/invites/${id}/resend`, { method: "POST", cookie });
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error).toBe("too_many_staff");
    expect((await row("SELECT expires_at FROM invites"))!.expires_at).toBeLessThan(Date.now());
    await env.CONTROL.prepare("DELETE FROM users WHERE email = 'm1@x.test'").run();
    expect((await api(`/api/staff/invites/${id}/resend`, { method: "POST", cookie })).status).toBe(200);
  });

  it("stops at 20 invites in 24 hours", async () => {
    const { cookie } = await setup();
    const owner = (await row("SELECT id FROM users"))!.id;
    const fid = (await me(cookie)).firm.id;
    const old = Date.now() - 25 * HOUR;
    // revoked, so they only count toward the daily limit
    const fill = (n: number, at: number) =>
      env.CONTROL.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n})
         INSERT INTO invites (id, firm_id, email, invited_by, created_at, expires_at, revoked_at)
         SELECT lower(hex(randomblob(16))), ?, 'r' || ? || '_' || i || '@x.test', ?, ?, ?, ? FROM n`,
      )
        .bind(fid, at, owner, at, at + 7 * DAY, at)
        .run();
    await fill(5, old);
    await fill(20, Date.now());
    mockOutbound();
    const res = await invite(cookie);
    expect(res.status).toBe(429);
    expect((await res.json<any>()).error).toBe("too_many_invites");
    await env.CONTROL.prepare("DELETE FROM invites WHERE created_at > ?").bind(old + 1).run();
    await fill(19, Date.now());
    expect((await invite(cookie)).status).toBe(201);
  });

  it("is refused for a trial that ran out and for a closed account", async () => {
    const { cookie } = await setup();
    mockOutbound();
    await env.CONTROL.prepare("UPDATE firms SET trial_ends_at = ?").bind(Date.now() - 1).run();
    expect((await invite(cookie)).status).toBe(402);
    await env.CONTROL.prepare("UPDATE firms SET trial_ends_at = ?, closed_at = ?").bind(Date.now() + DAY, Date.now()).run();
    expect((await invite(cookie)).status).toBe(403);
  });
});

describe("invite email", () => {
  it("counts toward the account's daily email cap", async () => {
    const { cookie } = await setup();
    const sent = mockOutbound();
    await invite(cookie);
    expect(sent).toHaveLength(1);
    expect(await staffMail()).toBe(1);

    await fillStaffMail((await me(cookie)).firm.id, 49);
    const res = await invite(cookie, "two@mail.test");
    expect(res.status).toBe(429);
    expect((await res.json<any>()).error).toBe("email_limit");
    expect(sent).toHaveLength(1);
    // the invite is kept, so Resend can send it once there is room
    expect((await list(cookie)).invites.map((i) => i.email)).toContain("two@mail.test");
  });

  it("takes room from client emails too", async () => {
    const { cookie, req } = await openRequest();
    await api("/api/firm", { method: "PATCH", cookie, body: { address: "1 King St, Toronto" } });
    const sent = mockOutbound();
    await fillStaffMail((await me(cookie)).firm.id, 50);
    const res = await api(`/api/requests/${req.id}/link`, { method: "POST", cookie, body: { send_email: true } });
    expect(res.status).toBe(429);
    expect(sent).toHaveLength(0);
  });

  it("frees the slot and keeps the invite when the provider refuses", async () => {
    const { cookie } = await setup();
    mockOutbound(true, false);
    expect((await invite(cookie)).status).toBe(502);
    expect(await staffMail()).toBe(0);
    const { invites } = await list(cookie);
    expect(invites).toHaveLength(1);
    const sent = mockOutbound();
    expect((await api(`/api/staff/invites/${invites[0].id}/resend`, { method: "POST", cookie })).status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("is sent again by resend, with a fresh expiry", async () => {
    const { cookie } = await setup();
    const sent = mockOutbound();
    const { id } = await (await invite(cookie)).json<any>();
    await env.CONTROL.prepare("UPDATE invites SET expires_at = ?").bind(Date.now() - 1).run();
    expect((await api(`/api/staff/invites/${id}/resend`, { method: "POST", cookie })).status).toBe(200);
    expect(sent).toHaveLength(2);
    expect((await row("SELECT expires_at FROM invites"))!.expires_at).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(await actions()).toEqual(["invite.send", "invite.send"]);
  });
});

describe("members", () => {
  it("get 403 on every staff route and on billing, and still do the daily work", async () => {
    const { cookie } = await setup();
    const member = await addMember(cookie);
    const owner = (await row("SELECT id FROM users WHERE role = 'owner'"))!.id;
    mockOutbound();
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/staff"],
      ["POST", "/api/staff/invites", { email: NEWBIE }],
      ["POST", `/api/staff/invites/${NONE}/resend`],
      ["DELETE", `/api/staff/invites/${NONE}`],
      ["DELETE", `/api/staff/${owner}`],
      ["POST", "/api/billing/checkout"],
      ["POST", "/api/billing/portal"],
    ];
    for (const [method, path, body] of calls) {
      expect((await api(path, { method, cookie: member, body })).status, `${method} ${path}`).toBe(403);
    }
    const made = await api("/api/clients", { method: "POST", cookie: member, body: { name: "Bo", contact_ok: false } });
    expect(made.status).toBe(201);
    expect((await api("/api/templates", { cookie: member })).status).toBe(200);
  });

  it("are signed out at once when removed", async () => {
    const { cookie } = await setup();
    const member = await addMember(cookie);
    const target = (await list(cookie)).people.find((p) => p.role === "member");
    expect((await api("/api/me", { cookie: member })).status).toBe(200);
    expect((await api(`/api/staff/${target.id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await api("/api/me", { cookie: member })).status).toBe(401);
    expect((await api("/api/clients", { cookie: member })).status).toBe(401);
    expect((await row("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", target.id))!.n).toBe(0);
    expect((await list(cookie)).people).toHaveLength(1);
    expect(await actions()).toContain("staff.remove");

    // signing in again stays refused
    const sent = mockOutbound();
    await start("member@firm.test");
    const res = await api("/api/auth/verify", { method: "POST", body: { email: "member@firm.test", code: codeFrom(sent[0]) } });
    expect(res.status).toBe(403);
  });

  it("cannot remove themselves, and the last owner stays", async () => {
    const { cookie } = await setup();
    const owner = (await row("SELECT id FROM users"))!.id;
    const res = await api(`/api/staff/${owner}`, { method: "DELETE", cookie });
    expect(res.status).toBe(409);
    expect((await res.json<any>()).error).toBe("cannot_remove_self");
    expect((await api(`/api/staff/${NONE}`, { method: "DELETE", cookie })).status).toBe(404);
    expect((await row("SELECT disabled_at FROM users"))!.disabled_at).toBeNull();
  });

  it("never leave an account without an owner when two owners remove each other", async () => {
    const { cookie } = await setup();
    const second = await addMember(cookie, "second@firm.test");
    await env.CONTROL.prepare("UPDATE users SET role = 'owner' WHERE email = 'second@firm.test'").run();
    const [a, b] = (await list(cookie)).people.map((p) => p.id);
    await Promise.all([api(`/api/staff/${b}`, { method: "DELETE", cookie }), api(`/api/staff/${a}`, { method: "DELETE", cookie: second })]);
    expect((await row("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled_at IS NULL"))!.n).toBe(1);
  });

  it("are re-enabled in place when invited again", async () => {
    const { cookie } = await setup();
    const old = await addMember(cookie);
    const before = (await row("SELECT id FROM users WHERE email = 'member@firm.test'"))!.id;
    await api(`/api/staff/${before}`, { method: "DELETE", cookie });
    mockOutbound();
    expect((await invite(cookie, "member@firm.test", { name: "Mel" })).status).toBe(201);
    const who = await me(await login("member@firm.test"));
    expect(who.user.id).toBe(before);
    expect(who.user.name).toBe("Mel");
    expect(who.user.role).toBe("member");
    expect((await row("SELECT COUNT(*) AS n FROM users WHERE email = 'member@firm.test'"))!.n).toBe(1);
    // the old session was deleted for good
    expect((await api("/api/me", { cookie: old })).status).toBe(401);
  });

  it("can move to another account that invites them after a removal", async () => {
    const { cookie } = await setup();
    const other = await setup("other@firm.test", "Other Firm");
    await addMember(cookie);
    const id = (await row("SELECT id FROM users WHERE email = 'member@firm.test'"))!.id;
    await api(`/api/staff/${id}`, { method: "DELETE", cookie });
    mockOutbound();
    expect((await invite(other.cookie, "member@firm.test")).status).toBe(201);
    expect((await me(await login("member@firm.test"))).firm.name).toBe("Other Firm");
  });
});

describe("tenant isolation", () => {
  it("keeps one account's owner away from another's invites and people", async () => {
    const a = await setup();
    const b = await setup("b@firm.test", "B Firm");
    await addMember(a.cookie);
    mockOutbound();
    const { id } = await (await invite(a.cookie)).json<any>();
    const member = (await row("SELECT id FROM users WHERE email = 'member@firm.test'"))!.id;

    expect((await api(`/api/staff/invites/${id}`, { method: "DELETE", cookie: b.cookie })).status).toBe(404);
    expect((await api(`/api/staff/invites/${id}/resend`, { method: "POST", cookie: b.cookie })).status).toBe(404);
    expect((await api(`/api/staff/${member}`, { method: "DELETE", cookie: b.cookie })).status).toBe(404);
    expect((await row("SELECT revoked_at FROM invites WHERE id = ?", id))!.revoked_at).toBeNull();
    expect((await row("SELECT disabled_at FROM users WHERE id = ?", member))!.disabled_at).toBeNull();
    const seen = await list(b.cookie);
    expect(seen.invites).toEqual([]);
    expect(seen.people.map((p) => p.email)).toEqual(["b@firm.test"]);
    expect((await firmRow(a.cookie)).id).not.toBe((await firmRow(b.cookie)).id);
  });
});

describe("revoke and purge", () => {
  it("revokes a pending invite and records it", async () => {
    const { cookie } = await setup();
    mockOutbound();
    const { id } = await (await invite(cookie)).json<any>();
    expect((await api(`/api/staff/invites/${id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await api(`/api/staff/invites/${id}`, { method: "DELETE", cookie })).status).toBe(404);
    expect((await list(cookie)).invites).toEqual([]);
    expect(await actions()).toEqual(["invite.send", "invite.revoke"]);
    expect((await invite(cookie)).status).toBe(201);
  });

  it("deletes a purged account's invites and staff mail", async () => {
    const { cookie } = await setup();
    mockOutbound();
    await invite(cookie);
    const fid = (await me(cookie)).firm.id;
    await api("/api/account/close", { method: "POST", cookie, body: { confirm: "Tuna Tax" } });
    await env.CONTROL.prepare("UPDATE firms SET closed_at = ?").bind(Date.now() - 31 * DAY).run();
    await purgeClosed(env);
    expect(await row("SELECT 1 FROM firms WHERE id = ?", fid)).toBeNull();
    expect((await row("SELECT COUNT(*) AS n FROM invites"))!.n).toBe(0);
    expect(await staffMail()).toBe(0);
  });
});
