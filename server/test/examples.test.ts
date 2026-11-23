import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { purgeClosed } from "../src/account";
import { BUILTIN_EXAMPLES } from "../src/examples";
import { builtinTemplates } from "../src/templates";
import { sweepFiles } from "../src/sweep";
import { DAY, HOUR } from "../src/util";
import { api, inDays, openRequest, pdf, randomBytes, setup } from "./helpers";

const png = (n: number) => Object.assign(randomBytes(n), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpg = (n: number) => Object.assign(randomBytes(n), [0xff, 0xd8, 0xff, 0xe0]);
const webp = (n: number) => Object.assign(randomBytes(n), [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

const MAX = 2 * 1024 * 1024;

let ip = 0;
function post(cookie: string, body: Uint8Array | ReadableStream | null, headers: Record<string, string> = {}) {
  return exports.default.fetch("https://collect.alazy.app/api/examples", {
    method: "POST",
    headers: { cookie, "X-Collect": "1", "CF-Connecting-IP": `198.51.100.${++ip % 250}`, ...headers },
    body,
    duplex: "half",
  } as RequestInit);
}

const make = async (cookie: string, bytes: Uint8Array = png(3000)) => (await post(cookie, bytes)).json<any>();
const objects = async () => (await env.FILES_NA.list({ prefix: "f/" })).objects.length;
const count = async (table = "examples") => (await env.DB_NA.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<any>())!.n;

// a request of its own whose item has the example
async function withExample(email = "owner@firm.test") {
  const o = await openRequest(email);
  const example = await make(o.cookie);
  const item = o.req.items[0].id;
  const set = await api(`/api/requests/${o.req.id}/items/${item}`, { method: "PATCH", cookie: o.cookie, body: { example: example.id } });
  expect(set.status).toBe(200);
  return { ...o, example, item };
}

describe("example upload", () => {
  it("keeps the image encrypted under the account's prefix and serves it back", async () => {
    const { cookie } = await setup();
    const bytes = png(5000);
    const res = await post(cookie, bytes, { "content-type": "image/png" });
    expect(res.status).toBe(201);
    const made = await res.json<any>();
    expect(made).toMatchObject({ mime: "image/png", size: 5000 });
    const row = (await env.DB_NA.prepare("SELECT * FROM examples").first<any>())!;
    expect(row.r2_key).toBe(`f/${row.firm_id}/x/${made.id}`);
    const object = new Uint8Array(await (await env.FILES_NA.get(row.r2_key))!.arrayBuffer());
    expect(object.length).toBeGreaterThan(5000);
    expect(object.subarray(4, 12)).not.toEqual(bytes.subarray(0, 8));
    expect((await env.DB_NA.prepare("SELECT 1 FROM audit WHERE action = 'example.upload' AND object_id = ?").bind(made.id).first())).not.toBeNull();

    const got = await api(`/api/examples/${made.id}`, { cookie });
    expect(got.status).toBe(200);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("goes by the first bytes and not by what the request says", async () => {
    const { cookie } = await setup();
    for (const [bytes, mime] of [[jpg(900), "image/jpeg"], [png(900), "image/png"], [webp(900), "image/webp"]] as const) {
      const res = await post(cookie, bytes, { "content-type": "application/pdf" });
      expect([mime, res.status, (await res.json<any>()).mime]).toEqual([mime, 201, mime]);
    }
    for (const bytes of [pdf(900), new TextEncoder().encode("GIF89a....."), randomBytes(500), new Uint8Array(0)]) {
      expect((await post(cookie, bytes, { "content-type": "image/png" })).status).toBe(415);
    }
    expect(await count()).toBe(3);
  });

  it("takes up to 2 MB, however the length is told", async () => {
    const { cookie } = await setup();
    expect((await post(cookie, png(MAX))).status).toBe(201);
    expect((await post(cookie, png(MAX + 1))).status).toBe(413);
    const stream = (n: number) => new ReadableStream({ start: (c) => (c.enqueue(png(n)), c.close()) });
    expect((await post(cookie, stream(MAX + 1))).status).toBe(413);
    expect((await post(cookie, stream(MAX))).status).toBe(201);
    expect(await count()).toBe(2);
    expect(await objects()).toBe(2);
  });

  it("needs a signed-in account", async () => {
    expect((await post("", png(100))).status).toBe(401);
    expect(await count()).toBe(0);
  });

  it("stops at 200 and lets unused ones make room", async () => {
    const o = await withExample();
    const firmId = (await env.DB_NA.prepare("SELECT firm_id FROM examples").first<any>())!.firm_id;
    await env.DB_NA.batch(
      Array.from({ length: 199 }, (_, i) =>
        env.DB_NA.prepare("INSERT INTO examples (id, firm_id, r2_key, mime, size, created_at) VALUES (?, ?, ?, 'image/png', 1, ?)").bind(`a${i.toString(16).padStart(31, "0")}`, firmId, `f/${firmId}/x/${i}`, Date.now()),
      ),
    );
    expect(await count()).toBe(200);
    const full = await post(o.cookie, png(100));
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: "too_many_examples" });

    // old ones that nothing uses are dropped to make room; the one an item has stays
    await env.DB_NA.prepare("UPDATE examples SET created_at = 1 WHERE id != ?").bind(o.example.id).run();
    expect((await post(o.cookie, png(100))).status).toBe(201);
    expect(await count()).toBe(2);
    expect((await env.DB_NA.prepare("SELECT 1 FROM examples WHERE id = ?").bind(o.example.id).first())).not.toBeNull();
  });
});

describe("firm isolation", () => {
  it("keeps one account's examples from another", async () => {
    const a = await withExample("a@firm.test");
    const b = await setup("b@firm.test", "Other Tax");
    expect((await api(`/api/examples/${a.example.id}`, { cookie: b.cookie })).status).toBe(404);

    const req = await (await api("/api/requests", { method: "POST", cookie: b.cookie, body: { client_id: b.client.id, title: "T", deadline: inDays(9), items: [{ label: "One", required: true }] } })).json<any>();
    const patch = await api(`/api/requests/${req.id}/items/${req.items[0].id}`, { method: "PATCH", cookie: b.cookie, body: { example: a.example.id } });
    expect(patch.status).toBe(409);
    expect(await patch.json()).toEqual({ error: "example_gone" });
    const items = [{ label: "One", required: true, example: a.example.id }];
    expect((await api("/api/templates", { method: "POST", cookie: b.cookie, body: { name: "x", items } })).status).toBe(409);
    expect((await api("/api/requests", { method: "POST", cookie: b.cookie, body: { client_id: b.client.id, title: "T", deadline: inDays(9), items } })).status).toBe(409);
    expect((await api(`/api/requests/${req.id}/items`, { method: "POST", cookie: b.cookie, body: items[0] })).status).toBe(409);
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM items WHERE example IS NOT NULL").first<any>())!.n).toBe(1);
  });

  it("refuses an id nobody made and names that are not built in", async () => {
    const { cookie, req } = await openRequest();
    for (const example of ["0".repeat(32), "nope", "../x", 5]) {
      const res = await api(`/api/requests/${req.id}/items/${req.items[0].id}`, { method: "PATCH", cookie, body: { example } });
      // an id nobody owns is gone; anything that is not an id or a built-in name is malformed
      expect([String(example), res.status]).toEqual([String(example), example === "0".repeat(32) ? 409 : 400]);
    }
  });
});

describe("example on the client page", () => {
  const link = (path: string, item: string) => api(`${path}/items/${item}/example`);

  it("shows the item its example and serves the image to the link", async () => {
    const o = await withExample();
    const view = await (await api(o.path)).json<any>();
    expect(view.items[0].example).toBe(o.example.id);
    expect(view.items[1].example).toBeNull();
    const res = await link(o.path, o.item);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("content-length")).toBe("3000");
    expect((await res.arrayBuffer()).byteLength).toBe(3000);
    expect((await link(o.path, o.req.items[1].id)).status).toBe(404);
  });

  it("is refused for another request's item, another account's, and unknown ones", async () => {
    const a = await withExample("a@firm.test");
    const b = await openRequest("b@firm.test");
    expect((await link(b.path, a.item)).status).toBe(404);
    expect((await link(a.path, b.req.items[0].id)).status).toBe(404);
    expect((await link(a.path, "0".repeat(32))).status).toBe(404);
    expect((await link(`/api/c/na_${"a".repeat(43)}`, a.item)).status).toBe(404);

    // a second request of the same account that uses the same example is its own scope
    const again = await (await api("/api/requests", { method: "POST", cookie: a.cookie, body: { client_id: a.req.client_id, title: "Other", deadline: inDays(9), items: [{ label: "Passport", required: true, example: a.example.id }] } })).json<any>();
    const url = (await (await api(`/api/requests/${again.id}/link`, { method: "POST", cookie: a.cookie })).json<any>()).url;
    const other = `/api/c/${url.split("/c/")[1]}`;
    expect((await link(other, again.items[0].id)).status).toBe(200);
    expect((await link(other, a.item)).status).toBe(404);
  });

  it("stops when the link is closed or replaced", async () => {
    const o = await withExample();
    expect((await link(o.path, o.item)).status).toBe(200);
    const fresh = (await (await api(`/api/requests/${o.req.id}/link`, { method: "POST", cookie: o.cookie })).json<any>()).url;
    expect((await link(o.path, o.item)).status).toBe(404);
    const path = `/api/c/${fresh.split("/c/")[1]}`;
    expect((await link(path, o.item)).status).toBe(200);
    await api(`/api/requests/${o.req.id}/close`, { method: "POST", cookie: o.cookie });
    expect((await link(path, o.item)).status).toBe(404);
  });

  it("does not serve the example of an item the client cannot see yet", async () => {
    const { cookie, client } = await setup();
    const example = await make(cookie);
    const items = [{ label: "Moved?", kind: "yesno", required: true }, { label: "Receipts", required: true, show_if: { item: 0, value: "yes" }, example: example.id }];
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "T", deadline: inDays(9), items } })).json<any>();
    const url = (await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>()).url;
    const path = `/api/c/${url.split("/c/")[1]}`;
    expect((await link(path, req.items[1].id)).status).toBe(404);
    await api(`${path}/items/${req.items[0].id}/answer`, { method: "PUT", body: { answer: "yes" } });
    expect((await link(path, req.items[1].id)).status).toBe(200);
  });
});

describe("built-in examples", () => {
  it("are named on the built-in templates and all known", () => {
    const named = builtinTemplates.flatMap((t) => t.items.map((i) => i.example)).filter(Boolean);
    expect(named.length).toBeGreaterThan(8);
    for (const name of named) expect(BUILTIN_EXAMPLES).toContain(name);
  });

  it("carry onto a request made from the template and show on the client page", async () => {
    const { cookie, client } = await setup();
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "Study", deadline: inDays(9), template_id: "ircc-study-permit", people: [{ role: "principal", name: "Omar" }] } })).json<any>();
    const passport = req.items.findIndex((i: any) => i.label === "Passport — Omar");
    expect(req.items[passport]).toMatchObject({ example: "passport" });
    const url = (await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>()).url;
    const view = await (await api(`/api/c/${url.split("/c/")[1]}`)).json<any>();
    expect(view.items[passport].example).toBe("passport");
    expect(await count()).toBe(0);
  });

  it("can be picked for an item, and cleared", async () => {
    const { cookie, req } = await openRequest();
    const url = `/api/requests/${req.id}/items/${req.items[0].id}`;
    expect(await (await api(url, { method: "PATCH", cookie, body: { example: "void-cheque" } })).json()).toMatchObject({ example: "void-cheque" });
    expect(await (await api(url, { method: "PATCH", cookie, body: { example: null } })).json()).toMatchObject({ example: null });
  });
});

describe("sharing an example", () => {
  const sameObject = async (id: string) => {
    expect(await count()).toBe(1);
    expect(await objects()).toBe(1);
    expect((await env.DB_NA.prepare("SELECT id FROM examples").first<any>())!.id).toBe(id);
  };

  it("is reused by a copied template, a request from it and a repeated request", async () => {
    const { cookie, client } = await setup();
    const example = await make(cookie);
    const items = [{ label: "Passport", required: true, example: example.id }, { label: "Visa", required: false }];
    const tpl = await (await api("/api/templates", { method: "POST", cookie, body: { name: "Mine", items } })).json<any>();
    expect(tpl.items[0].example).toBe(example.id);

    const copy = await (await api("/api/templates", { method: "POST", cookie, body: { name: "Copy of Mine", items: tpl.items } })).json<any>();
    expect(copy.items[0].example).toBe(example.id);

    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "2025", deadline: inDays(9), template_id: copy.id } })).json<any>();
    expect(req.items.map((i: any) => i.example)).toEqual([example.id, null]);
    const again = await (await api(`/api/requests/${req.id}/repeat`, { method: "POST", cookie })).json<any>();
    expect(again.items.map((i: any) => i.example)).toEqual([example.id, null]);
    await sameObject(example.id);
  });

  it("stays while an item or a template names it, and goes once nothing does", async () => {
    const { cookie, client } = await setup();
    const example = await make(cookie);
    const items = [{ label: "Passport", required: true, example: example.id }];
    const tpl = await (await api("/api/templates", { method: "POST", cookie, body: { name: "Mine", items } })).json<any>();
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "2025", deadline: inDays(9), template_id: tpl.id } })).json<any>();
    const later = Date.now() + 2 * DAY;

    await sweepFiles(env, later);
    await sameObject(example.id);

    await api(`/api/templates/${tpl.id}`, { method: "DELETE", cookie });
    await sweepFiles(env, later);
    await sameObject(example.id);

    await api(`/api/requests/${req.id}/items/${req.items[0].id}`, { method: "PATCH", cookie, body: { example: null } });
    await sweepFiles(env, later);
    expect([await count(), await objects()]).toEqual([0, 0]);
  });

  it("is spared while it is new, so one just uploaded can still be saved onto an item", async () => {
    const { cookie } = await setup();
    const example = await make(cookie);
    await sweepFiles(env, Date.now());
    await sameObject(example.id);
    await sweepFiles(env, Date.now() + 2 * HOUR);
    await sameObject(example.id);
    await sweepFiles(env, Date.now() + 2 * DAY);
    expect(await count()).toBe(0);
  });

  it("keeps an item's example when the template that held it is edited", async () => {
    const { cookie, client } = await setup();
    const example = await make(cookie);
    const tpl = await (await api("/api/templates", { method: "POST", cookie, body: { name: "Mine", items: [{ label: "P", required: true, example: example.id }] } })).json<any>();
    const req = await (await api("/api/requests", { method: "POST", cookie, body: { client_id: client.id, title: "2025", deadline: inDays(9), template_id: tpl.id } })).json<any>();
    await api(`/api/templates/${tpl.id}`, { method: "PATCH", cookie, body: { items: [{ label: "P", required: true }] } });
    await sweepFiles(env, Date.now() + 2 * DAY);
    await sameObject(example.id);
    expect(req.items[0].example).toBe(example.id);
  });
});

describe("purge with the account", () => {
  it("removes the examples and their objects when a closed account is purged", async () => {
    const o = await withExample();
    expect([await count(), await objects()]).toEqual([1, 1]);
    await api("/api/account/close", { method: "POST", cookie: o.cookie, body: { confirm: "Tuna Tax" } });
    await env.CONTROL.prepare("UPDATE firms SET closed_at = ? WHERE closed_at IS NOT NULL").bind(Date.now() - 31 * DAY).run();
    await purgeClosed(env);
    expect(await env.CONTROL.prepare("SELECT 1 FROM firms").first()).toBeNull();
    expect([await count(), await objects()]).toEqual([0, 0]);
  });
});
