import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY } from "../src/util";
import { api, inDays, setup } from "./helpers";

const make = (cookie: string, body: Record<string, unknown>) => api("/api/requests", { method: "POST", cookie, body });
const item = { label: "Passport", required: true };

describe("requests", () => {
  it("answers 401 without a session", async () => {
    expect((await api("/api/requests")).status).toBe(401);
    expect((await api("/api/requests", { method: "POST", body: {} })).status).toBe(401);
    expect((await api("/api/requests/x/link", { method: "POST" })).status).toBe(401);
  });

  it("creates a draft with its own items", async () => {
    const { cookie, client } = await setup();
    const res = await make(cookie, { client_id: client.id, title: "2025 taxes", note: "Please hurry", deadline: inDays(7), items: [item, { label: "Visa", required: false }] });
    expect(res.status).toBe(201);
    const body = await res.json<any>();
    expect(body).toMatchObject({ client_id: client.id, title: "2025 taxes", note: "Please hurry", status: "draft", sent_at: null });
    expect(body.items.map((i: any) => [i.position, i.label, i.required, i.status])).toEqual([
      [0, "Passport", true, "empty"],
      [1, "Visa", false, "empty"],
    ]);
  });

  it("copies a built-in template into items", async () => {
    const { cookie, client } = await setup();
    const templates = await (await api("/api/templates", { cookie })).json<any[]>();
    const built = templates.find((t) => t.id === "ircc-study-permit");
    const body = await (await make(cookie, { client_id: client.id, title: "Study permit", deadline: inDays(7), template_id: "ircc-study-permit" })).json<any>();
    // what is asked for each person waits for the people; the rest is copied in order
    const plain = built.items.filter((i: any) => !i.per_person);
    const copied = body.items.filter((i: any) => plain.some((p: any) => p.label === i.label));
    expect(copied.map((i: any) => i.label)).toEqual(plain.map((i: any) => i.label));
    expect(copied.map((i: any) => i.required)).toEqual(plain.map((i: any) => i.required));
  });

  it("copies a firm template and keeps later template edits out of the request", async () => {
    const { cookie, client } = await setup();
    const t = await (await api("/api/templates", { method: "POST", cookie, body: { name: "Mine", items: [item] } })).json<any>();
    const body = await (await make(cookie, { client_id: client.id, title: "A", deadline: inDays(7), template_id: t.id })).json<any>();
    await api(`/api/templates/${t.id}`, { method: "PATCH", cookie, body: { items: [{ label: "Other" }] } });
    const again = await (await api(`/api/requests/${body.id}`, { cookie })).json<any>();
    expect(again.items.map((i: any) => i.label)).toEqual(["Passport"]);
  });

  it("rejects bad input", async () => {
    const { cookie, client } = await setup();
    const ok = { client_id: client.id, title: "A", deadline: inDays(7) };
    expect((await make(cookie, { ...ok, title: "" })).status).toBe(400);
    expect((await make(cookie, { ...ok, deadline: "tomorrow" })).status).toBe(400);
    expect((await make(cookie, { ...ok, deadline: Date.now() - 1000 })).status).toBe(400);
    expect((await make(cookie, { ...ok, note: 5 })).status).toBe(400);
    expect((await make(cookie, { ...ok, items: [] })).status).toBe(400);
    expect((await make(cookie, { ...ok, items: [item], template_id: "t1-personal" })).status).toBe(400);
    expect((await make(cookie, { ...ok, client_id: undefined })).status).toBe(400);
    expect((await make(cookie, { ...ok, client_id: "nope" })).status).toBe(404);
    expect((await make(cookie, { ...ok, template_id: "nope" })).status).toBe(404);
    const count = await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM requests").first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("refuses a deleted client", async () => {
    const { cookie, client } = await setup();
    await api(`/api/clients/${client.id}`, { method: "DELETE", cookie });
    expect((await make(cookie, { client_id: client.id, title: "A", deadline: inDays(7) })).status).toBe(404);
  });

  it("lists newest first with counts per item status", async () => {
    const { cookie, client } = await setup();
    const first = await (await make(cookie, { client_id: client.id, title: "First", deadline: inDays(7), items: [item, item, item] })).json<any>();
    await new Promise((r) => setTimeout(r, 5));
    await make(cookie, { client_id: client.id, title: "Second", deadline: inDays(7) });
    await env.DB_NA.prepare("UPDATE items SET status = 'submitted' WHERE request_id = ? AND position = 0").bind(first.id).run();
    await env.DB_NA.prepare("UPDATE items SET status = 'approved' WHERE request_id = ? AND position = 1").bind(first.id).run();
    const list = (await (await api("/api/requests", { cookie })).json<any>()).rows as any[];
    expect(list.map((r) => r.title)).toEqual(["Second", "First"]);
    expect(list[0]).toMatchObject({ empty: 0, submitted: 0, approved: 0, rejected: 0, client_name: "Amy" });
    expect(list[1]).toMatchObject({ empty: 1, submitted: 1, approved: 1, rejected: 0 });
  });

  it("hides deleted requests", async () => {
    const { cookie, client } = await setup();
    const r = await (await make(cookie, { client_id: client.id, title: "A", deadline: inDays(7) })).json<any>();
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1 WHERE id = ?").bind(r.id).run();
    expect((await (await api("/api/requests", { cookie })).json<any>()).rows).toEqual([]);
    expect((await api(`/api/requests/${r.id}`, { cookie })).status).toBe(404);
  });

  it("updates title, note and deadline", async () => {
    const { cookie, client } = await setup();
    const r = await (await make(cookie, { client_id: client.id, title: "A", deadline: inDays(7) })).json<any>();
    const patch = (body: unknown) => api(`/api/requests/${r.id}`, { method: "PATCH", cookie, body });
    const due = inDays(10);
    expect(await (await patch({ title: "B", note: "n", deadline: due })).json()).toMatchObject({ title: "B", note: "n", deadline: due });
    expect(await (await patch({ note: null })).json()).toMatchObject({ note: null });
    expect((await patch({ title: "" })).status).toBe(400);
    expect((await patch({ deadline: 5 })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
  });

  it("adds, edits and deletes items on a draft", async () => {
    const { cookie, client } = await setup();
    const r = await (await make(cookie, { client_id: client.id, title: "A", deadline: inDays(7), items: [item] })).json<any>();
    const base = `/api/requests/${r.id}/items`;
    const added = await api(base, { method: "POST", cookie, body: { label: "Visa", help: "Page 2", required: false } });
    expect(added.status).toBe(201);
    const it2 = await added.json<any>();
    expect(it2).toMatchObject({ position: 1, label: "Visa", help: "Page 2", required: false, status: "empty" });
    const patched = await api(`${base}/${it2.id}`, { method: "PATCH", cookie, body: { label: "Visa copy", required: true } });
    expect(await patched.json()).toMatchObject({ label: "Visa copy", required: true });
    expect((await api(base, { method: "POST", cookie, body: { label: "" } })).status).toBe(400);
    expect((await api(`${base}/${it2.id}`, { method: "PATCH", cookie, body: { required: "yes" } })).status).toBe(400);
    expect((await api(`${base}/nope`, { method: "PATCH", cookie, body: { label: "x" } })).status).toBe(404);
    expect((await api(`${base}/${it2.id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await api(`${base}/${it2.id}`, { method: "DELETE", cookie })).status).toBe(404);
    const after = await (await api(`/api/requests/${r.id}`, { cookie })).json<any>();
    expect(after.items).toHaveLength(1);
  });

  it("keeps an item that already has a status", async () => {
    const { cookie, client } = await setup();
    const r = await (await make(cookie, { client_id: client.id, title: "A", deadline: inDays(7), items: [item] })).json<any>();
    await env.DB_NA.prepare("UPDATE items SET status = 'submitted' WHERE request_id = ?").bind(r.id).run();
    expect((await api(`/api/requests/${r.id}/items/${r.items[0].id}`, { method: "DELETE", cookie })).status).toBe(409);
  });

  it("locks items once the request is closed", async () => {
    const { cookie, client } = await setup();
    const r = await (await make(cookie, { client_id: client.id, title: "A", deadline: inDays(7), items: [item] })).json<any>();
    expect((await api(`/api/requests/${r.id}/close`, { method: "POST", cookie })).status).toBe(200);
    const after = await (await api(`/api/requests/${r.id}`, { cookie })).json<any>();
    expect(after.status).toBe("closed");
    expect(after.closed_at).toBeGreaterThan(0);
    expect((await api(`/api/requests/${r.id}/items`, { method: "POST", cookie, body: item })).status).toBe(409);
    expect((await api(`/api/requests/${r.id}/items/${r.items[0].id}`, { method: "PATCH", cookie, body: { label: "x" } })).status).toBe(409);
    expect((await api(`/api/requests/${r.id}/items/${r.items[0].id}`, { method: "DELETE", cookie })).status).toBe(409);
  });
});

describe("request link", () => {
  const link = (cookie: string, id: string) => api(`/api/requests/${id}/link`, { method: "POST", cookie });
  const draft = async (cookie: string, clientId: string) =>
    (await (await make(cookie, { client_id: clientId, title: "A", deadline: inDays(7), items: [item] })).json<any>()).id as string;

  it("creates a link, opens the request and writes an audit row", async () => {
    const { cookie, client } = await setup();
    const id = await draft(cookie, client.id);
    const res = await link(cookie, id);
    expect(res.status).toBe(200);
    const { url } = await res.json<any>();
    expect(url).toMatch(/^https:\/\/collect\.alazy\.app\/c\/na_[\w-]{43}$/);
    const req = await (await api(`/api/requests/${id}`, { cookie })).json<any>();
    expect(req).toMatchObject({ status: "open", firm_name: "Tuna Tax" });
    expect(req.sent_at).toBeGreaterThan(0);
    const row = await env.DB_NA.prepare("SELECT token_hash, expires_at FROM links WHERE request_id = ?").bind(id).first<any>();
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(url).not.toContain(row.token_hash);
    expect(row.expires_at).toBe(req.deadline + 30 * DAY);
    const audit = await env.DB_NA.prepare("SELECT actor_type, action, object_id FROM audit WHERE action = 'link.create'").all<any>();
    expect(audit.results).toEqual([{ actor_type: "user", action: "link.create", object_id: id }]);
  });

  it("needs the firm name first", async () => {
    const { cookie, client } = await setup("owner@firm.test", null);
    const res = await link(cookie, await draft(cookie, client.id));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "firm_profile" });
  });

  it("answers 402 after the trial ends and works again when active", async () => {
    const { cookie, client } = await setup();
    const id = await draft(cookie, client.id);
    await env.CONTROL.prepare("UPDATE firms SET trial_ends_at = ?").bind(Date.now() - 1000).run();
    expect((await link(cookie, id)).status).toBe(402);
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'active'").run();
    expect((await link(cookie, id)).status).toBe(200);
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'past_due'").run();
    expect((await link(cookie, id)).status).toBe(402);
  });

  it("keeps a past due account working for a week after its first failed payment", async () => {
    const { cookie, client } = await setup();
    const id = await draft(cookie, client.id);
    await env.CONTROL.prepare("UPDATE firms SET plan_status = 'past_due', past_due_since = ?").bind(Date.now() - 6 * 86_400_000).run();
    expect((await link(cookie, id)).status).toBe(200);
    await env.CONTROL.prepare("UPDATE firms SET past_due_since = ?").bind(Date.now() - 8 * 86_400_000).run();
    expect((await link(cookie, id)).status).toBe(402);
  });

  it("revokes the previous link when a new one is made", async () => {
    const { cookie, client } = await setup();
    const id = await draft(cookie, client.id);
    await link(cookie, id);
    await link(cookie, id);
    const rows = await env.DB_NA.prepare("SELECT revoked_at FROM links ORDER BY created_at").all<any>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.filter((r) => r.revoked_at === null)).toHaveLength(1);
  });

  it("refuses a closed request", async () => {
    const { cookie, client } = await setup();
    const id = await draft(cookie, client.id);
    await api(`/api/requests/${id}/close`, { method: "POST", cookie });
    expect((await link(cookie, id)).status).toBe(409);
  });

  it("moves the live link's expiry with the deadline", async () => {
    const { cookie, client } = await setup();
    const id = await draft(cookie, client.id);
    await link(cookie, id);
    const due = inDays(20);
    await api(`/api/requests/${id}`, { method: "PATCH", cookie, body: { deadline: due } });
    const row = await env.DB_NA.prepare("SELECT expires_at FROM links").first<any>();
    expect(row.expires_at).toBe(due + 30 * DAY);
  });
});

describe("request rules", () => {
  const mk = async (cookie: string, clientId: string) =>
    (await (await make(cookie, { client_id: clientId, title: "A", deadline: inDays(7), items: [item] })).json<any>()).id as string;

  it("limits the deadline to two years ahead", async () => {
    const { cookie, client } = await setup();
    const ok = { client_id: client.id, title: "A" };
    expect((await make(cookie, { ...ok, deadline: inDays(731) })).status).toBe(400);
    expect((await make(cookie, { ...ok, deadline: inDays(729) })).status).toBe(201);
    const id = await mk(cookie, client.id);
    expect((await api(`/api/requests/${id}`, { method: "PATCH", cookie, body: { deadline: inDays(731) } })).status).toBe(400);
  });

  it("refuses a link once the deadline has passed", async () => {
    const { cookie, client } = await setup();
    const id = await mk(cookie, client.id);
    await env.DB_NA.prepare("UPDATE requests SET deadline = ?").bind(Date.now() - 1000).run();
    const res = await api(`/api/requests/${id}/link`, { method: "POST", cookie });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "deadline_passed" });
  });

  it("revokes the live link when the request is closed", async () => {
    const { cookie, client } = await setup();
    const id = await mk(cookie, client.id);
    await api(`/api/requests/${id}/link`, { method: "POST", cookie });
    await api(`/api/requests/${id}/close`, { method: "POST", cookie });
    const row = await env.DB_NA.prepare("SELECT revoked_at FROM links").first<any>();
    expect(row.revoked_at).toBeGreaterThan(0);
  });

  it("locks a closed request against edits", async () => {
    const { cookie, client } = await setup();
    const id = await mk(cookie, client.id);
    await api(`/api/requests/${id}/close`, { method: "POST", cookie });
    expect((await api(`/api/requests/${id}`, { method: "PATCH", cookie, body: { title: "B" } })).status).toBe(409);
  });

  it("gates a deadline change on an open request behind the plan", async () => {
    const { cookie, client } = await setup();
    const id = await mk(cookie, client.id);
    const patch = (body: unknown) => api(`/api/requests/${id}`, { method: "PATCH", cookie, body });
    expect((await patch({ deadline: inDays(8) })).status).toBe(200);
    await api(`/api/requests/${id}/link`, { method: "POST", cookie });
    await env.CONTROL.prepare("UPDATE firms SET trial_ends_at = ?").bind(Date.now() - 1000).run();
    expect((await patch({ deadline: inDays(9) })).status).toBe(402);
    expect((await patch({ title: "B" })).status).toBe(200);
  });
});

describe("request delete", () => {
  it("hides the request, revokes its link and writes an audit row", async () => {
    const { cookie, client } = await setup();
    const { id } = await (await make(cookie, { client_id: client.id, title: "A", deadline: inDays(7), items: [item] })).json<any>();
    const { url } = await (await api(`/api/requests/${id}/link`, { method: "POST", cookie })).json<any>();
    expect((await api(`/api/requests/${id}`, { method: "DELETE", cookie })).status).toBe(200);
    expect((await api(`/api/requests/${id}`, { cookie })).status).toBe(404);
    expect((await (await api("/api/requests", { cookie })).json<any>()).rows).toEqual([]);
    expect((await api(`/api/c/${url.split("/c/")[1]}`)).status).toBe(404);
    const link = await env.DB_NA.prepare("SELECT revoked_at FROM links").first<any>();
    expect(link.revoked_at).toBeGreaterThan(0);
    const rows = await env.DB_NA.prepare("SELECT action, object_id FROM audit WHERE action = 'request.delete'").all<any>();
    expect(rows.results).toEqual([{ action: "request.delete", object_id: id }]);
    expect((await api(`/api/requests/${id}`, { method: "DELETE", cookie })).status).toBe(404);
  });
});

describe("item cap", () => {
  it("refuses a 301st item", async () => {
    const { cookie, client } = await setup();
    const items = Array.from({ length: 100 }, (_, i) => ({ label: `Item ${i}` }));
    const r = await (await make(cookie, { client_id: client.id, title: "A", deadline: inDays(7), items })).json<any>();
    // a request made of templates with people and translations can hold more than a template does
    await env.DB_NA.prepare(
      "INSERT INTO items (id, firm_id, request_id, position, label) SELECT lower(hex(randomblob(16))), i.firm_id, i.request_id, 100 + j.value, 'Extra' FROM items i, json_each(?) j WHERE i.id = ?",
    )
      .bind(JSON.stringify(Array.from({ length: 200 }, (_, i) => i)), r.items[0].id)
      .run();
    const res = await api(`/api/requests/${r.id}/items`, { method: "POST", cookie, body: item });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "too_many_items" });
    const count = await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
    expect(count!.n).toBe(300);
    await api(`/api/requests/${r.id}/items/${r.items[0].id}`, { method: "DELETE", cookie });
    expect((await api(`/api/requests/${r.id}/items`, { method: "POST", cookie, body: item })).status).toBe(201);
  });
});

describe("request audit", () => {
  it("logs request and item changes once each", async () => {
    const { cookie, client } = await setup();
    await env.DB_NA.prepare("DELETE FROM audit").run();
    const r = await (await make(cookie, { client_id: client.id, title: "A", deadline: inDays(7), items: [item] })).json<any>();
    await api(`/api/requests/${r.id}`, { method: "PATCH", cookie, body: { title: "B" } });
    const added = await (await api(`/api/requests/${r.id}/items`, { method: "POST", cookie, body: item })).json<any>();
    await api(`/api/requests/${r.id}/items/${added.id}`, { method: "PATCH", cookie, body: { label: "x" } });
    await api(`/api/requests/${r.id}/items/${added.id}`, { method: "DELETE", cookie });
    await api(`/api/requests/${r.id}/items/${added.id}`, { method: "DELETE", cookie });
    await api(`/api/requests/${r.id}/close`, { method: "POST", cookie });
    await api(`/api/requests/${r.id}/close`, { method: "POST", cookie });
    const rows = (await env.DB_NA.prepare("SELECT action, object_type, object_id FROM audit ORDER BY at, rowid").all<any>()).results;
    expect(rows.map((x) => x.action)).toEqual(["request.create", "request.update", "item.add", "item.edit", "item.delete", "request.close"]);
    expect(rows.filter((x) => x.action.startsWith("request")).every((x) => x.object_type === "request" && x.object_id === r.id)).toBe(true);
    expect(rows[2]).toMatchObject({ object_type: "item", object_id: added.id });
  });
});
