import { describe, expect, it } from "vitest";
import { api, openRequest, setup } from "./helpers";

describe("recording a prepared IRCC export", () => {
  const post = (cookie: string, id: string, body: unknown) => api(`/api/requests/${id}/export/ircc`, { method: "POST", cookie, body });

  it("writes one export row with the limit and the number of files", async () => {
    const { cookie, req } = await openRequest();
    expect((await post(cookie, req.id, { files: 7, limit_mb: 4 })).status).toBe(204);
    const { rows } = await (await api(`/api/requests/${req.id}/activity`, { cookie })).json<{ rows: any[] }>();
    expect(rows.filter((r) => r.action === "export.ircc")).toHaveLength(1);
  });

  it("refuses bad input, no session and another firm's request", async () => {
    const { cookie, req } = await openRequest();
    for (const body of [{}, { files: 0, limit_mb: 4 }, { files: 1.5, limit_mb: 4 }, { files: 3, limit_mb: 3 }, { files: "3", limit_mb: 4 }]) {
      expect([JSON.stringify(body), (await post(cookie, req.id, body)).status]).toEqual([JSON.stringify(body), 400]);
    }
    expect((await post("", req.id, { files: 1, limit_mb: 4 })).status).toBe(401);
    const other = await setup("b@two.test", "Two Inc");
    expect((await post(other.cookie, req.id, { files: 1, limit_mb: 4 })).status).toBe(404);
  });
});
