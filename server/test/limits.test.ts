import { createScheduledController } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { hmac, randomId } from "../src/util";
import { api, codeFrom, cookieFrom, linkFrom, mockOutbound, start } from "./helpers";

const EMAIL = "owner@firm.test";

const verify = (code: string, init: { ip?: string } = {}) =>
  api("/api/auth/verify", { method: "POST", body: { email: EMAIL, code }, ...init });

describe("csrf without the header", () => {
  it("rejects a POST that carries no X-Collect at all", async () => {
    const res = await exports.default.fetch("https://collect.alazy.app/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(403);
  });
});

describe("verify limits", () => {
  it("fails the right code after 10 parallel wrong guesses", async () => {
    const sent = mockOutbound();
    await start(EMAIL);
    const code = codeFrom(sent[0]);
    const wrong = code === "000000" ? "111111" : "000000";
    const results = await Promise.all(Array.from({ length: 10 }, () => verify(wrong)));
    expect(results.every((r) => r.status === 400)).toBe(true);
    expect((await verify(code)).status).toBe(400);
    const row = await env.CONTROL.prepare("SELECT attempts FROM login_codes").first<{ attempts: number }>();
    expect(row!.attempts).toBe(3);
  });

  it("refuses codes after 10 failures in 24 hours but still takes the link", async () => {
    const sent = mockOutbound();
    const now = Date.now();
    await env.CONTROL.prepare(
      "INSERT INTO login_codes (id, email, email_hash, code_hash, link_hash, attempts, expires_at, used_at, created_at) VALUES (?, ?, ?, 'x', ?, 10, ?, ?, ?)",
    )
      .bind(randomId(), EMAIL, await hmac(env.HASH_KEY, EMAIL), randomId(), now - 1, now - 1, now - 3_600_000)
      .run();
    await start(EMAIL);
    expect((await verify(codeFrom(sent[0]))).status).toBe(429);
    const t = linkFrom(sent[0]).split("t=")[1];
    expect((await api("/api/auth/link", { method: "POST", body: { t } })).status).toBe(200);
  });

  it("answers 429 once the verify limiter is used up", async () => {
    mockOutbound();
    const ip = "198.51.100.7";
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await verify("123456", { ip })).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses).toContain(429);
  });
});

describe("start", () => {
  it("returns 502 and leaves no row when Resend fails", async () => {
    mockOutbound(true, false);
    const res = await start(EMAIL);
    expect(res.status).toBe(502);
    const row = await env.CONTROL.prepare("SELECT COUNT(*) AS n FROM login_codes").first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it("lets a newer code and link replace the older ones", async () => {
    const sent = mockOutbound();
    await start(EMAIL);
    await start(EMAIL);
    expect(sent).toHaveLength(2);
    expect((await verify(codeFrom(sent[0]))).status).toBe(400);
    const oldToken = linkFrom(sent[0]).split("t=")[1];
    expect((await api("/api/auth/link", { method: "POST", body: { t: oldToken } })).status).toBe(400);
    expect((await verify(codeFrom(sent[1]))).status).toBe(200);
  });

  it("creates one firm and one user when two first sign-ins race", async () => {
    const sent = mockOutbound();
    await start(EMAIL);
    const t = linkFrom(sent[0]).split("t=")[1];
    const [a, b] = await Promise.all([verify(codeFrom(sent[0])), api("/api/auth/link", { method: "POST", body: { t } })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const me = await (await api("/api/me", { cookie: cookieFrom(a) })).json<any>();
    const counts = await env.CONTROL.prepare("SELECT (SELECT COUNT(*) FROM users) AS u, (SELECT COUNT(*) FROM firms) AS f").first<{
      u: number;
      f: number;
    }>();
    expect(counts).toEqual({ u: 1, f: 1 });
    expect(me.user.email).toBe(EMAIL);
  });
});

describe("cleanup cron", () => {
  it("deletes old login codes and expired sessions", async () => {
    mockOutbound();
    const now = Date.now();
    const db = env.CONTROL;
    const [firm, user, oldId, newId] = [randomId(), randomId(), randomId(), randomId()];
    await db.prepare("INSERT INTO firms (id, plan_status, created_at) VALUES (?, 'trialing', ?)").bind(firm, now).run();
    await db.prepare("INSERT INTO users (id, firm_id, email, role, created_at) VALUES (?, ?, 'a@b.test', 'owner', ?)").bind(user, firm, now).run();
    const code = (id: string, created: number) =>
      db
        .prepare("INSERT INTO login_codes (id, email, email_hash, code_hash, link_hash, expires_at, created_at) VALUES (?, 'a@b.test', 'h', 'c', ?, ?, ?)")
        .bind(id, id, created + 600_000, created);
    const session = (hash: string, expires: number) =>
      db.prepare("INSERT INTO sessions (token_hash, user_id, firm_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(hash, user, firm, now, now, expires);
    await db.batch([code(oldId, now - 25 * 3_600_000), code(newId, now), session("dead", now - 1), session("live", now + 100_000)]);

    await worker.scheduled(createScheduledController({ scheduledTime: now }), env);

    const codes = await db.prepare("SELECT id FROM login_codes").all<{ id: string }>();
    const sessions = await db.prepare("SELECT token_hash FROM sessions").all<{ token_hash: string }>();
    expect(codes.results.map((r) => r.id)).toEqual([newId]);
    expect(sessions.results.map((r) => r.token_hash)).toEqual(["live"]);
  });
});
