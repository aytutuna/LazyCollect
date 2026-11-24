import { Hono, type Context } from "hono";
import { auditLogin } from "./audit";
import { rateLimited } from "./auth";
import { PENDING_TRIES, createSession, sessionLabel, endPending, loadPending, type AppEnv, type Pending } from "./session";
import { invalid, readBody, text } from "./validate";
import { authenticationOptions, registrationOptions, savePasskey, verifyAssertion, verifyRegistration, type Passkey } from "./webauthn";

// The second step of signing in, after a good email code or link. Everything here runs on the pending cookie alone;
// only finish() makes a session.
export const pending = new Hono<AppEnv>();

const gone = (c: Context) => c.json({ error: "pending_expired" }, 401);

// the new session's token, or null when the pending login was already used
async function finish(c: Context<AppEnv>, p: Pending): Promise<string | null> {
  // deleting the row is what makes the token single use
  const taken = await c.env.CONTROL.prepare("DELETE FROM pending_logins WHERE token_hash = ? RETURNING 1 AS ok").bind(p.tokenHash).first();
  if (!taken) return null;
  await endPending(c);
  return createSession(c, p.userId, p.firmId, p.app);
}

pending.get("/auth/pending", async (c) => {
  const p = await loadPending(c);
  return c.json(p ? { step: p.step, role: p.role, email: p.email } : { step: null });
});

pending.delete("/auth/pending", async (c) => {
  await endPending(c);
  return c.json({ ok: true });
});

pending.post("/auth/pending/options", async (c) => {
  if (await rateLimited(c.env, c.env.VERIFY, c.req.header("CF-Connecting-IP"))) return c.json({ error: "rate_limited" }, 429);
  const p = await loadPending(c);
  if (!p) return gone(c);
  const have = (await c.env.CONTROL.prepare("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at, id").bind(p.userId).all<Passkey>()).results;
  return c.json(
    p.step === "passkey"
      ? { kind: "authenticate", options: await authenticationOptions(c.env, p.userId, have) }
      : { kind: "register", options: await registrationOptions(c.env, { id: p.userId, email: p.email, name: p.name }, have) },
  );
});

pending.post("/auth/pending/verify", async (c) => {
  if (await rateLimited(c.env, c.env.VERIFY, c.req.header("CF-Connecting-IP"))) return c.json({ error: "rate_limited" }, 429);
  const p = await loadPending(c);
  if (!p) return gone(c);
  const body = await readBody(c);
  if (!body || typeof body.response !== "object" || body.response === null) return invalid(c);
  // counted before the check so parallel guesses can't exceed the limit
  const tried = await c.env.CONTROL.prepare("UPDATE pending_logins SET attempts = attempts + 1 WHERE token_hash = ? AND attempts < ?").bind(p.tokenHash, PENDING_TRIES).run();
  if (tried.meta.changes !== 1) {
    await endPending(c);
    return gone(c);
  }

  if (p.step === "passkey") {
    const result = await verifyAssertion(c.env, p.userId, body.response as never);
    if (!result.ok) {
      if (result.reason === "counter") {
        await endPending(c);
        await auditLogin(c.env, p.firmId, p.userId, "passkey.counter_refused", "passkey", result.passkey!.id);
        return c.json({ error: "passkey_counter" }, 403);
      }
      return c.json({ error: "passkey_failed" }, 400);
    }
  } else {
    const name = body.name === undefined || body.name === "" ? sessionLabel(c, p.app) : text(body.name, 60);
    if (!name) return invalid(c);
    const verified = await verifyRegistration(c.env, p.userId, body.response as never);
    if (!verified) return c.json({ error: "passkey_failed" }, 400);
    const id = await savePasskey(c.env, p.userId, name, verified);
    if (!id) return c.json({ error: "passkey_exists" }, 409);
    await auditLogin(c.env, p.firmId, p.userId, "passkey.add", "passkey", id, { name, enrol: true });
  }
  const token = await finish(c, p);
  if (!token) return gone(c);
  return c.json(p.app ? { ok: true, token } : { ok: true });
});
