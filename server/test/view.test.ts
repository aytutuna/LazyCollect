import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, jpeg, login, openRequest, pdf, randomBytes, sha, upload } from "./helpers";

const png = (n: number) => Object.assign(randomBytes(n), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const webp = (n: number) => Object.assign(randomBytes(n), [0x52, 0x49, 0x46, 0x46], { 8: 0x57, 9: 0x45, 10: 0x42, 11: 0x50 });
const heic = (n: number) => Object.assign(randomBytes(n), { 4: 0x66, 5: 0x74, 6: 0x79, 7: 0x70, 8: 0x68, 9: 0x65, 10: 0x69, 11: 0x63 });

async function stored(body: Uint8Array, name: string) {
  const o = await openRequest();
  const res = await upload(o.path, o.req.items[0].id, body, { name });
  expect(res.status).toBe(201);
  return { ...o, file: await res.json<any>() };
}

describe("inline view", () => {
  it.each([
    ["image/jpeg", jpeg, "a.jpg"],
    ["image/png", png, "a.png"],
    ["image/webp", webp, "a.webp"],
    ["application/pdf", pdf, "a.pdf"],
  ])("serves %s decrypted with an exact type and no script", async (mime, make, name) => {
    const body = make(4000);
    const { cookie, file } = await stored(body, name);
    const res = await api(`/api/files/${file.id}/view`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(mime);
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="a\./);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("script-src");
    expect(csp.includes("sandbox")).toBe(mime !== "application/pdf");
    expect(await sha(await res.arrayBuffer())).toBe(await sha(body));
  });

  it("refuses HEIC, which a browser cannot show, but still downloads it", async () => {
    const { cookie, file } = await stored(heic(3000), "a.heic");
    const res = await api(`/api/files/${file.id}/view`, { cookie });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "not_viewable" });
    const down = await api(`/api/files/${file.id}`, { cookie });
    expect(down.headers.get("content-disposition")).toMatch(/^attachment/);
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'file.view'").first<any>())!.n).toBe(1);
  });

  it("keeps the plain route an attachment", async () => {
    const { cookie, file } = await stored(pdf(2000), "a.pdf");
    const res = await api(`/api/files/${file.id}`, { cookie });
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("content-security-policy")).toBeNull();
  });

  it("audits each view as file.view with the request", async () => {
    const { cookie, req, file } = await stored(jpeg(2000), "a.jpg");
    await api(`/api/files/${file.id}/view`, { cookie });
    await api(`/api/files/${file.id}/view`, { cookie });
    const rows = (await env.DB_NA.prepare("SELECT * FROM audit WHERE action = 'file.view'").all<any>()).results;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_type: "user", object_type: "file", object_id: file.id });
    expect(JSON.parse(rows[0].meta)).toEqual({ request: req.id });
  });

  it("answers HEAD with 405 and writes nothing", async () => {
    const { cookie, file } = await stored(jpeg(2000), "a.jpg");
    expect((await api(`/api/files/${file.id}/view`, { method: "HEAD", cookie })).status).toBe(405);
    expect((await env.DB_NA.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'file.view'").first<any>())!.n).toBe(0);
  });

  it("needs a session and stays inside the account", async () => {
    const { file } = await stored(jpeg(2000), "a.jpg");
    expect((await api(`/api/files/${file.id}/view`)).status).toBe(401);
    const other = await login("b@two.test");
    expect((await api(`/api/files/${file.id}/view`, { cookie: other })).status).toBe(404);
  });

  it("is 404 for a deleted request and for an unknown file", async () => {
    const { cookie, req, file } = await stored(jpeg(2000), "a.jpg");
    expect((await api(`/api/files/${"0".repeat(32)}/view`, { cookie })).status).toBe(404);
    await api(`/api/requests/${req.id}`, { method: "DELETE", cookie });
    expect((await api(`/api/files/${file.id}/view`, { cookie })).status).toBe(404);
  });

  it("limits views and downloads together to 60 a minute per account", async () => {
    const { cookie, file } = await stored(jpeg(500), "a.jpg");
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) statuses.push((await api(`/api/files/${file.id}${i % 2 ? "" : "/view"}`, { cookie })).status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    const other = await openRequest("c@three.test");
    const f = await (await upload(other.path, other.req.items[0].id, jpeg(500))).json<any>();
    expect((await api(`/api/files/${f.id}/view`, { cookie: other.cookie })).status).toBe(200);
  });
});
