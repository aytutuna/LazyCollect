import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DAY } from "../src/util";
import { api, inDays, setup } from "./helpers";

async function openRequest(email = "owner@firm.test") {
  const { cookie, client } = await setup(email);
  const req = await (
    await api("/api/requests", {
      method: "POST",
      cookie,
      body: { client_id: client.id, title: "2025 taxes", note: "Hurry", deadline: inDays(7), items: [{ label: "Passport", help: "All pages", required: true }, { label: "Visa", required: false }] },
    })
  ).json<any>();
  const { url } = await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>();
  return { cookie, req, path: `/api/c/${url.split("/c/")[1]}` };
}

describe("client link", () => {
  it("shows the request for a fresh link", async () => {
    const { path } = await openRequest();
    const res = await api(path);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toMatchObject({ firm_name: "Tuna Tax", title: "2025 taxes", note: "Hurry", status: "open" });
    expect(body.items.map((i: any) => [i.label, i.help, i.required, i.status, i.reject_note])).toEqual([
      ["Passport", "All pages", true, "empty", null],
      ["Visa", null, false, "empty", null],
    ]);
    expect(Object.keys(body.items[0]).sort()).toEqual(["help", "id", "label", "reject_note", "required", "status"]);
  });

  it("logs a view at most once an hour per link", async () => {
    const { path } = await openRequest();
    await api(path);
    await api(path);
    const count = () => env.DB_NA.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'link.open'").first<{ n: number }>();
    expect((await count())!.n).toBe(1);
    await env.DB_NA.prepare("UPDATE audit SET at = ? WHERE action = 'link.open'").bind(Date.now() - 2 * 3_600_000).run();
    await api(path);
    expect((await count())!.n).toBe(2);
    const row = await env.DB_NA.prepare("SELECT actor_type, object_type, ip_hash FROM audit WHERE action = 'link.open'").first<any>();
    expect(row.actor_type).toBe("client");
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("answers the same 404 for every kind of bad token", async () => {
    const { cookie, req, path } = await openRequest();
    const token = path.split("/c/")[1];
    const bodies = new Set<string>();
    const expect404 = async (p: string) => {
      const res = await api(p);
      expect(res.status).toBe(404);
      bodies.add(await res.text());
    };
    await expect404("/api/c/garbage");
    await expect404(`/api/c/xx_${token.slice(3)}`);
    await expect404(`/api/c/na_${"A".repeat(43)}`);
    await expect404(`/api/c/${token.slice(0, -1)}`);

    await env.DB_NA.prepare("UPDATE links SET expires_at = ?").bind(Date.now() - 1).run();
    await expect404(path);
    await env.DB_NA.prepare("UPDATE links SET expires_at = ?").bind(Date.now() + DAY).run();
    expect((await api(path)).status).toBe(200);

    await api(`/api/requests/${req.id}/close`, { method: "POST", cookie });
    await expect404(path);
    await env.DB_NA.batch([
      env.DB_NA.prepare("UPDATE requests SET status = 'open', closed_at = NULL"),
      env.DB_NA.prepare("UPDATE links SET revoked_at = NULL"),
    ]);
    expect((await api(path)).status).toBe(200);
    await env.DB_NA.prepare("UPDATE requests SET deleted_at = 1").run();
    await expect404(path);
    expect(bodies.size).toBe(1);
  });

  it("stops working for a revoked link once a new one is made", async () => {
    const { cookie, req, path } = await openRequest();
    const { url } = await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>();
    expect((await api(path)).status).toBe(404);
    expect((await api(`/api/c/${url.split("/c/")[1]}`)).status).toBe(200);
  });

  it("answers 429 once the client limiter is used up", async () => {
    const ip = "198.51.100.9";
    const statuses = [];
    for (let i = 0; i < 65; i++) statuses.push((await api("/api/c/garbage", { ip })).status);
    expect(statuses.slice(0, 60).every((s) => s === 404)).toBe(true);
    expect(statuses).toContain(429);
  });
});
