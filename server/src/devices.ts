import { Hono } from "hono";
import { audit } from "./audit";
import type { AppEnv } from "./session";
import { notFound } from "./validate";

export const devices = new Hono<AppEnv>();

devices.get("/sessions", async (c) => {
  const session = c.get("session")!;
  const { results } = await c.env.CONTROL
    .prepare("SELECT id, label, created_at, last_seen_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen_at DESC, created_at DESC")
    .bind(session.userId, Date.now())
    .all<{ id: string | null; label: string | null; created_at: number; last_seen_at: number }>();
  return c.json(results.map((r) => ({ ...r, current: r.id === session.id })));
});

devices.post("/sessions/end-others", async (c) => {
  const session = c.get("session")!;
  const res = await c.env.CONTROL.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(session.userId, session.tokenHash).run();
  await audit(c, "session.end_others", "user", session.userId, { count: res.meta.changes }).run();
  return c.json({ ok: true });
});

devices.delete("/sessions/:id", async (c) => {
  const session = c.get("session")!;
  const id = c.req.param("id");
  if (id === session.id) return c.json({ error: "current_session" }, 409);
  const res = await c.env.CONTROL.prepare("DELETE FROM sessions WHERE id = ? AND user_id = ?").bind(id, session.userId).run();
  if (!res.meta.changes) return notFound(c);
  await audit(c, "session.end", "user", session.userId).run();
  return c.json({ ok: true });
});
