import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY, randomId } from "../src/util";
import { api, inDays, setup } from "./helpers";

type Page = { rows: any[]; next: number | null; counts: Record<string, number> | null; client: { id: string; name: string } | null };

async function account(email = "owner@firm.test") {
  const { cookie, client } = await setup(email);
  const me = await (await api("/api/me", { cookie })).json<any>();
  return { cookie, client, firmId: me.firm.id as string };
}

type Seed = { status?: string; deadline?: number; created?: number; items?: [string, number][]; sent?: number | null };

async function seed(firmId: string, clientId: string, title: string, o: Seed = {}) {
  const id = randomId();
  const stmts = [
    env.DB_NA.prepare("INSERT INTO requests (id, firm_id, client_id, title, deadline, status, sent_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'u', ?)").bind(
      id,
      firmId,
      clientId,
      title,
      o.deadline ?? inDays(20),
      o.status ?? "open",
      o.sent ?? null,
      o.created ?? Date.now(),
    ),
    ...(o.items ?? [["empty", 1]]).map(([status, required], i) =>
      env.DB_NA.prepare("INSERT INTO items (id, firm_id, request_id, position, label, required, status) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(randomId(), firmId, id, i, `Item ${i}`, required, status),
    ),
  ];
  await env.DB_NA.batch(stmts);
  return id;
}

const list = async (cookie: string, query = "") => {
  const res = await api(`/api/requests${query}`, { cookie });
  expect(res.status).toBe(200);
  return res.json<Page>();
};
const titles = (p: Page) => p.rows.map((r) => r.title).sort();

describe("home views", () => {
  async function nine() {
    const a = await account();
    const f = a.firmId;
    const c = a.client.id;
    await seed(f, c, "review", { items: [["submitted", 1], ["empty", 1]] });
    await seed(f, c, "review done", { status: "complete", items: [["submitted", 1]] });
    await seed(f, c, "waiting", { deadline: inDays(30), items: [["empty", 1], ["empty", 0]] });
    await seed(f, c, "overdue", { deadline: Date.now() - 2 * DAY, items: [["rejected", 1]] });
    await seed(f, c, "soon", { deadline: inDays(3), items: [["empty", 1]] });
    await seed(f, c, "finished", { status: "complete", items: [["approved", 1]] });
    await seed(f, c, "shut", { status: "closed", items: [["empty", 1]] });
    await seed(f, c, "draft", { status: "draft", items: [["empty", 1]] });
    await seed(f, c, "optional only", { deadline: inDays(30), items: [["empty", 0]] });
    return a;
  }

  it("sorts requests into the five views and counts each one", async () => {
    const { cookie } = await nine();
    expect(titles(await list(cookie, "?view=to_review"))).toEqual(["review", "review done"]);
    expect(titles(await list(cookie, "?view=waiting"))).toEqual(["overdue", "review", "soon", "waiting"]);
    expect(titles(await list(cookie, "?view=overdue"))).toEqual(["overdue"]);
    expect(titles(await list(cookie, "?view=due_soon"))).toEqual(["soon"]);
    expect(titles(await list(cookie, "?view=done"))).toEqual(["finished", "review done", "shut"]);
    expect((await list(cookie, "?view=all")).rows).toHaveLength(9);
    expect((await list(cookie)).counts).toEqual({ all: 9, to_review: 2, waiting: 4, overdue: 1, due_soon: 1, done: 3 });
  });

  it("carries the item counts the progress bar needs", async () => {
    const { cookie } = await nine();
    const row = (await list(cookie, "?view=to_review")).rows.find((r) => r.title === "review");
    expect(row).toMatchObject({ client_name: "Amy", submitted: 1, empty: 1, approved: 0, rejected: 0 });
    expect(row).not.toHaveProperty("missing");
  });

  it("applies the status filter with a view and counts under it", async () => {
    const { cookie } = await nine();
    const page = await list(cookie, "?status=complete&view=to_review");
    expect(titles(page)).toEqual(["review done"]);
    expect(page.counts).toEqual({ all: 2, to_review: 1, waiting: 0, overdue: 0, due_soon: 0, done: 2 });
  });

  it("answers counts only on the first page", async () => {
    const { cookie } = await nine();
    expect((await list(cookie, "?offset=5")).counts).toBeNull();
  });

  it("refuses values it does not know", async () => {
    const { cookie } = await nine();
    for (const q of ["view=x", "sort=x", "sort=toString", "view=constructor", "status=toString", "status=x", "client=nope", "offset=-1", "offset=1e3", "offset=100001", `q=${"a".repeat(101)}`]) {
      expect([q, (await api(`/api/requests?${q}`, { cookie })).status]).toEqual([q, 400]);
    }
  });
});

describe("search", () => {
  it("matches the client's name and email and the request's title, ignoring case", async () => {
    const a = await account();
    const bo = await (await api("/api/clients", { method: "POST", cookie: a.cookie, body: { name: "Bo Chen", email: "bo@mail.test", contact_ok: true } })).json<any>();
    await seed(a.firmId, a.client.id, "Study permit");
    await seed(a.firmId, bo.id, "T1 2025");
    expect(titles(await list(a.cookie, "?q=amy"))).toEqual(["Study permit"]);
    expect(titles(await list(a.cookie, "?q=BO%40MAIL"))).toEqual(["T1 2025"]);
    expect(titles(await list(a.cookie, "?q=permit"))).toEqual(["Study permit"]);
    expect(titles(await list(a.cookie, "?q=%20%20chen%20"))).toEqual(["T1 2025"]);
    expect((await list(a.cookie, "?q=zzz")).rows).toEqual([]);
    expect((await list(a.cookie, "?q=zzz")).counts).toMatchObject({ all: 0 });
  });

  it("treats % _ and ! as plain characters", async () => {
    const a = await account();
    for (const t of ["100% done", "a_b", "axb", "wow!", "plain"]) await seed(a.firmId, a.client.id, t);
    expect(titles(await list(a.cookie, "?q=%25"))).toEqual(["100% done"]);
    expect(titles(await list(a.cookie, "?q=_"))).toEqual(["a_b"]);
    expect(titles(await list(a.cookie, "?q=a_b"))).toEqual(["a_b"]);
    expect(titles(await list(a.cookie, "?q=!"))).toEqual(["wow!"]);
    expect((await list(a.cookie, "?q=%5C")).rows).toEqual([]);
    expect((await list(a.cookie, `?q=${encodeURIComponent("' OR 1=1 --")}`)).rows).toEqual([]);
  });

  it("filters by client", async () => {
    const a = await account();
    const bo = await (await api("/api/clients", { method: "POST", cookie: a.cookie, body: { name: "Bo", contact_ok: false } })).json<any>();
    await seed(a.firmId, a.client.id, "Amy's");
    await seed(a.firmId, bo.id, "Bo's");
    expect(titles(await list(a.cookie, `?client=${bo.id}`))).toEqual(["Bo's"]);
    expect((await list(a.cookie, `?client=${bo.id}`)).counts).toMatchObject({ all: 1 });
    expect((await list(a.cookie, `?client=${bo.id}`)).client).toEqual({ id: bo.id, name: "Bo" });
    expect((await list(a.cookie, `?client=${bo.id}&offset=1`)).client).toEqual({ id: bo.id, name: "Bo" });
    expect((await list(a.cookie)).client).toBeNull();
  });

  it("never shows another account's requests or counts them", async () => {
    const a = await account();
    const b = await account("b@two.test");
    await seed(a.firmId, a.client.id, "Mine shared");
    await seed(b.firmId, b.client.id, "Theirs shared");
    const mine = await list(a.cookie, "?q=shared");
    expect(titles(mine)).toEqual(["Mine shared"]);
    expect(mine.counts).toMatchObject({ all: 1 });
    expect(titles(await list(a.cookie, `?client=${b.client.id}`))).toEqual([]);
    expect((await list(a.cookie, `?client=${b.client.id}`)).client).toBeNull();
    expect(titles(await list(b.cookie))).toEqual(["Theirs shared"]);
  });

  it("hides deleted requests and requests of deleted clients", async () => {
    const a = await account();
    const gone = await seed(a.firmId, a.client.id, "Gone");
    await seed(a.firmId, a.client.id, "Kept");
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1 WHERE id = ?").bind(gone).run();
    expect(titles(await list(a.cookie))).toEqual(["Kept"]);
    await env.DB_NA.prepare("UPDATE clients SET deleted_at = 1").run();
    expect((await list(a.cookie)).rows).toEqual([]);
  });
});

describe("paging and sorting", () => {
  it("pages 50 at a time with a next offset and no repeats", async () => {
    const a = await account();
    const now = Date.now();
    for (let i = 0; i < 120; i++) await seed(a.firmId, a.client.id, `R${i}`, { created: now + i });
    const first = await list(a.cookie);
    expect(first.rows).toHaveLength(50);
    expect(first.next).toBe(50);
    expect(first.counts).toMatchObject({ all: 120 });
    const second = await list(a.cookie, "?offset=50");
    const third = await list(a.cookie, "?offset=100");
    expect(second.next).toBe(100);
    expect(third.rows).toHaveLength(20);
    expect(third.next).toBeNull();
    const ids = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(120);
    expect(first.rows[0].title).toBe("R119");
  });

  it("pages exactly 50 without a phantom next page", async () => {
    const a = await account();
    for (let i = 0; i < 50; i++) await seed(a.firmId, a.client.id, `R${i}`);
    expect((await list(a.cookie)).next).toBeNull();
  });

  it("sorts by newest, deadline and last activity", async () => {
    const a = await account();
    const now = Date.now();
    const x = await seed(a.firmId, a.client.id, "x", { created: now - 3000, deadline: inDays(9), sent: now - 3000 });
    await seed(a.firmId, a.client.id, "y", { created: now - 2000, deadline: inDays(5), sent: now - 2000 });
    await seed(a.firmId, a.client.id, "z", { created: now - 1000, deadline: inDays(7), sent: now - 1000 });
    const order = async (sort: string) => (await list(a.cookie, `?sort=${sort}`)).rows.map((r) => r.title);
    expect(await order("newest")).toEqual(["z", "y", "x"]);
    expect(await order("deadline")).toEqual(["y", "z", "x"]);
    expect(await order("activity")).toEqual(["z", "y", "x"]);
    // a review makes the oldest request the most recently touched
    await env.DB_NA.prepare("UPDATE items SET reviewed_at = ? WHERE request_id = ?").bind(now, x).run();
    expect(await order("activity")).toEqual(["x", "z", "y"]);
    // so does a client upload
    await env.DB_NA.prepare("UPDATE items SET reviewed_at = NULL WHERE request_id = ?").bind(x).run();
    expect(await order("activity")).toEqual(["z", "y", "x"]);
    const item = (await env.DB_NA.prepare("SELECT id FROM items WHERE request_id = ?").bind(x).first<any>())!;
    await env.DB_NA.prepare(
      "INSERT INTO files (id, firm_id, request_id, item_id, r2_key, name, mime, size, upload_id, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, 'k', 'a.pdf', 'application/pdf', 1, 'u', 'client', ?)",
    )
      .bind(randomId(), a.firmId, x, item.id, now)
      .run();
    expect(await order("activity")).toEqual(["x", "z", "y"]);
  });

  it("uses the new indexes for the account's requests and their items", async () => {
    const a = await account();
    await seed(a.firmId, a.client.id, "x");
    const plan = (
      await env.DB_NA.prepare(
        "EXPLAIN QUERY PLAN SELECT r.id, SUM(i.status = 'submitted') FROM requests r LEFT JOIN items i ON i.firm_id = r.firm_id AND i.request_id = r.id WHERE r.firm_id = ? AND r.deleted_at IS NULL AND r.status = 'open' GROUP BY r.id",
      )
        .bind(a.firmId)
        .all<any>()
    ).results
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toContain("idx_items_summary");
    expect(plan).not.toMatch(/SCAN (items|requests)\b/);
  });
});

describe("clients page search", () => {
  const page = async (cookie: string, query = "") => (await api(`/api/clients/search${query}`, { cookie })).json<{ rows: any[]; next: number | null }>();

  it("searches name, email and phone, escapes wildcards and counts each client's requests", async () => {
    const a = await account();
    for (const [name, email, phone] of [["Bo 100%", "bo@x.test", ""], ["Cy_Lee", "cy@x.test", "416 555 0101"], ["Di", "di@y.test", ""]]) {
      await api("/api/clients", { method: "POST", cookie: a.cookie, body: { name, email, phone, contact_ok: true } });
    }
    await seed(a.firmId, a.client.id, "one");
    await seed(a.firmId, a.client.id, "two");
    const all = await page(a.cookie);
    expect(all.rows.map((r) => [r.name, r.requests])).toEqual([["Amy", 2], ["Bo 100%", 0], ["Cy_Lee", 0], ["Di", 0]]);
    expect((await page(a.cookie, "?q=%25")).rows.map((r) => r.name)).toEqual(["Bo 100%"]);
    expect((await page(a.cookie, "?q=_")).rows.map((r) => r.name)).toEqual(["Cy_Lee"]);
    expect((await page(a.cookie, "?q=Y%40X")).rows.map((r) => r.name)).toEqual(["Cy_Lee"]);
    expect((await page(a.cookie, "?q=555")).rows.map((r) => r.name)).toEqual(["Cy_Lee"]);
    expect((await page(a.cookie, "?q=AMY")).rows.map((r) => r.name)).toEqual(["Amy"]);
  });

  it("pages 50 at a time and stays inside the account", async () => {
    const a = await account();
    const b = await account("b@two.test");
    await env.DB_NA.batch(
      Array.from({ length: 60 }, (_, i) =>
        env.DB_NA.prepare("INSERT INTO clients (id, firm_id, name, created_by, created_at) VALUES (?, ?, ?, 'u', ?)").bind(randomId(), a.firmId, `C${String(i).padStart(2, "0")}`, Date.now()),
      ),
    );
    const first = await page(a.cookie);
    expect(first.rows).toHaveLength(50);
    expect(first.next).toBe(50);
    const second = await page(a.cookie, "?offset=50");
    expect(second.rows).toHaveLength(11);
    expect(second.next).toBeNull();
    expect((await page(b.cookie)).rows.map((r) => r.name)).toEqual(["Amy"]);
    expect((await api("/api/clients/search?offset=x", { cookie: a.cookie })).status).toBe(400);
    expect((await api("/api/clients/search")).status).toBe(401);
  });
});

describe("activity sort", () => {
  it("counts a new client message as activity", async () => {
    const a = await account();
    const x = await seed(a.firmId, a.client.id, "x");
    const y = await seed(a.firmId, a.client.id, "y");
    await env.DB_NA.prepare("UPDATE requests SET created_at = 100 WHERE id = ?").bind(x).run();
    await env.DB_NA.prepare("UPDATE requests SET created_at = 200 WHERE id = ?").bind(y).run();
    expect((await list(a.cookie, "?sort=activity")).rows.map((r) => r.title)).toEqual(["y", "x"]);
    await env.DB_NA.prepare("INSERT INTO notes (id, firm_id, request_id, author, body, created_at) VALUES (?, ?, ?, 'client', 'hi', ?)").bind(randomId(), a.firmId, x, Date.now()).run();
    expect((await list(a.cookie, "?sort=activity")).rows.map((r) => r.title)).toEqual(["x", "y"]);
  });
});
