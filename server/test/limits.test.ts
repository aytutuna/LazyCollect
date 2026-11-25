import { createScheduledController } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { runTimed } from "../src/timed";
import { atHour } from "../src/tz";
import { MINUTE, hmac, randomId } from "../src/util";
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
    // the limiter window can roll over mid-loop; 25 calls overflow one window either way
    for (let i = 0; i < 25; i++) statuses.push((await verify("123456", { ip })).status);
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
    await db.batch([code(oldId, now - 25 * 3_600_000), code(newId, now), session("dead", now - 11 * 60_000), session("live", now + 100_000)]);

    // the cleanup runs on every tenth minute
    await worker.scheduled(createScheduledController({ scheduledTime: now - (now % 600_000) }), env);

    const codes = await db.prepare("SELECT id FROM login_codes").all<{ id: string }>();
    const sessions = await db.prepare("SELECT token_hash FROM sessions").all<{ token_hash: string }>();
    expect(codes.results.map((r) => r.id)).toEqual([newId]);
    expect(sessions.results.map((r) => r.token_hash)).toEqual(["live"]);
  });
});

// D1 calls in one timed run: every statement and every batch counts once
function counting(env: Env, tally: { calls: number }): Env {
  const real = new WeakMap<object, object>();
  const stmt = (s: D1PreparedStatement): D1PreparedStatement => {
    const p: D1PreparedStatement = new Proxy(s, {
      get(t, k) {
        if (k === "bind") return (...a: unknown[]) => stmt(t.bind(...a));
        const v = (t as any)[k];
        if (k === "run" || k === "all" || k === "first" || k === "raw") return (...a: unknown[]) => (tally.calls++, v.apply(t, a));
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    real.set(p, s);
    return p;
  };
  const db = (d: D1Database): D1Database =>
    new Proxy(d, {
      get(t, k) {
        if (k === "prepare") return (q: string) => stmt(t.prepare(q));
        if (k === "batch") return (list: D1PreparedStatement[]) => (tally.calls++, t.batch(list.map((x) => (real.get(x) ?? x) as D1PreparedStatement)));
        const v = (t as any)[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return new Proxy(env, {
    get: (t, k) => (k === "DB_NA" || k === "CONTROL" ? db((t as any)[k]) : (t as any)[k]),
  });
}

describe("a busy January", () => {
  const ACCOUNTS = 10;
  const CLIENTS = 1000;
  const TZ = "America/Toronto";

  async function seed() {
    const now = Date.now();
    const day = { y: 2027, m: 1, d: 12 };
    const nine = atHour(day, 9, TZ);
    const deadline = atHour({ y: 2027, m: 1, d: 20 }, 23, TZ);
    for (let f = 1; f <= ACCOUNTS; f++) {
      const firm = f.toString(16).padStart(32, "0");
      const id = (kind: number, i: number) => ((kind * 1_000_000 + f * 10_000 + i).toString(16)).padStart(32, "0");
      await env.CONTROL.batch([
        env.CONTROL.prepare("INSERT INTO firms (id, name, address, plan_status, stripe_subscription_id, created_at) VALUES (?, ?, '1 King St W', 'active', 'sub_x', ?)").bind(firm, `Firm ${f}`, now),
        env.CONTROL.prepare("INSERT INTO users (id, firm_id, email, role, created_at) VALUES (?, ?, ?, 'owner', ?)").bind(id(9, 0), firm, `owner${f}@firm.test`, now),
      ]);
      const rows = (insert: string) =>
        env.DB_NA.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${CLIENTS}) ${insert}`);
      const hex = (kind: number) => `printf('%032x', ${kind * 1_000_000 + f * 10_000} + i)`;
      await env.DB_NA.batch([
        rows(`INSERT INTO clients (id, firm_id, name, email, email_ok_at, created_by, created_at) SELECT ${hex(1)}, ?1, 'Client ' || i, 'c' || i || '@x${f}.test', ?2, 'u', ?2 FROM n`).bind(firm, now),
        rows(
          `INSERT INTO requests (id, firm_id, client_id, title, deadline, status, tz, reminders_on, next_reminder_at, created_by, created_at)
           SELECT ${hex(2)}, ?1, ${hex(1)}, 'Taxes', ?2, 'open', ?4, 1, ?3, 'u', ?3 FROM n`,
        ).bind(firm, deadline, nine, TZ),
        rows(`INSERT INTO items (id, firm_id, request_id, position, label, status) SELECT ${hex(3)}, ?1, ${hex(2)}, 0, 'Passport', 'empty' FROM n`).bind(firm),
      ]);
    }
    return nine;
  }

  // the runtime caps the timers a request may leave pending, and ten thousand sends in a few seconds go past it
  const quietTimers = () => vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);

  it("sends 10 accounts' 1,000 reminders each between 9:00 and 13:00, in runs of at most 800 database calls", async () => {
    quietTimers();
    const sent = mockOutbound();
    const nine = await seed();
    const tally = { calls: 0 };
    const counted = counting(env, tally);
    let worst = 0;
    for (let m = 0; m < 4 * 60; m++) {
      tally.calls = 0;
      await runTimed(counted, nine + m * MINUTE);
      worst = Math.max(worst, tally.calls);
      if (sent.length === ACCOUNTS * CLIENTS) break;
    }
    console.log(`reminders ${sent.length}, most calls in one run ${worst}`);
    expect(sent).toHaveLength(ACCOUNTS * CLIENTS);
    expect(worst).toBeLessThanOrEqual(800);
    const left = await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM requests WHERE reminder_seq = 0").first<{ n: number }>();
    expect(left!.n).toBe(0);
  }, 900_000);

  it("sends nothing twice when two runs overlap", async () => {
    quietTimers();
    const sent = mockOutbound();
    const nine = await seed();
    await Promise.all([runTimed(env, nine), runTimed(env, nine)]);
    expect(sent).toHaveLength(60);
    expect(new Set(sent.map((m: any) => m.to[0])).size).toBe(60);
    const claims = await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'reminder'").first<{ n: number }>();
    expect(claims!.n).toBe(60);
  });
});
