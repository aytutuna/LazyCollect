import { Hono } from "hono";
import { audit } from "./audit";
import { isOwner } from "./firm";
import { deviceLabel, type AppEnv } from "./session";
import { invalid, notFound, readBody, text } from "./validate";
import { registrationOptions, savePasskey, verifyRegistration, type Passkey } from "./webauthn";

export const passkeys = new Hono<AppEnv>();

const mine = async (env: Env, userId: string) =>
  (await env.CONTROL.prepare("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at, id").bind(userId).all<Passkey>()).results;

passkeys.get("/passkeys", async (c) => {
  const list = await mine(c.env, c.get("session")!.userId);
  return c.json({
    required: c.get("firm").require_passkeys === 1,
    passkeys: list.map((p) => ({ id: p.id, name: p.name, user_verified: p.user_verified === 1, created_at: p.created_at, last_used_at: p.last_used_at })),
  });
});

passkeys.post("/passkeys/options", async (c) => {
  const userId = c.get("session")!.userId;
  const user = (await c.env.CONTROL.prepare("SELECT id, email, name FROM users WHERE id = ?").bind(userId).first<{ id: string; email: string; name: string | null }>())!;
  return c.json(await registrationOptions(c.env, user, await mine(c.env, userId)));
});

passkeys.post("/passkeys", async (c) => {
  const body = await readBody(c);
  if (!body || typeof body.response !== "object" || body.response === null) return invalid(c);
  const name = body.name === undefined || body.name === "" ? deviceLabel(c.req.header("User-Agent")) : text(body.name, 60);
  if (!name) return invalid(c);
  const userId = c.get("session")!.userId;
  const verified = await verifyRegistration(c.env, userId, body.response as never);
  if (!verified) return c.json({ error: "passkey_failed" }, 400);
  const id = await savePasskey(c.env, userId, name, verified);
  if (!id) return c.json({ error: "passkey_exists" }, 409);
  await audit(c, "passkey.add", "passkey", id, { name }).run();
  return c.json({ id }, 201);
});

passkeys.delete("/passkeys/:id", async (c) => {
  const id = c.req.param("id");
  const userId = c.get("session")!.userId;
  const res = await c.env.CONTROL.prepare(
    `DELETE FROM passkeys WHERE id = ?1 AND user_id = ?2
     AND (NOT EXISTS (SELECT 1 FROM firms WHERE id = ?3 AND require_passkeys = 1) OR (SELECT COUNT(*) FROM passkeys WHERE user_id = ?2) > 1)`,
  )
    .bind(id, userId, c.get("firm").id)
    .run();
  if (!res.meta.changes) {
    return (await c.env.CONTROL.prepare("SELECT 1 FROM passkeys WHERE id = ? AND user_id = ?").bind(id, userId).first()) ? c.json({ error: "last_passkey" }, 409) : notFound(c);
  }
  await audit(c, "passkey.remove", "passkey", id).run();
  return c.json({ ok: true });
});

passkeys.use("/security/*", async (c, next) => ((await isOwner(c)) ? next() : c.json({ error: "forbidden" }, 403)));

passkeys.get("/security/policy", async (c) => {
  const { results } = await c.env.CONTROL
    .prepare("SELECT id, email, name FROM users WHERE firm_id = ? AND disabled_at IS NULL AND NOT EXISTS (SELECT 1 FROM passkeys WHERE user_id = users.id) ORDER BY created_at, id")
    .bind(c.get("firm").id)
    .all<{ id: string; email: string; name: string | null }>();
  return c.json({ require_passkeys: c.get("firm").require_passkeys === 1, without: results });
});

passkeys.put("/security/policy", async (c) => {
  const body = await readBody(c);
  if (typeof body?.require_passkeys !== "boolean") return invalid(c);
  const on = body.require_passkeys;
  const firm = c.get("firm");
  if (on === (firm.require_passkeys === 1)) return c.json({ ok: true });
  // the owner's own passkey is checked in the update, so it can't be removed between a look and the switch
  const res = await c.env.CONTROL.prepare(
    "UPDATE firms SET require_passkeys = ?1 WHERE id = ?2 AND (?1 = 0 OR EXISTS (SELECT 1 FROM passkeys WHERE user_id = ?3))",
  )
    .bind(on ? 1 : 0, firm.id, c.get("session")!.userId)
    .run();
  if (!res.meta.changes) return c.json({ error: "passkey_needed" }, 409);
  await audit(c, "security.require_passkeys", "firm", firm.id, { on }).run();
  return c.json({ ok: true });
});
