import { Hono, type Context } from "hono";
import { audit } from "./audit";
import { normalizeEmail } from "./auth";
import { sendInviteEmail } from "./email";
import { isOwner, untouchedRegion, usable } from "./firm";
import { claimStaffMail } from "./mail";
import type { AppEnv } from "./session";
import { DAY, randomId } from "./util";
import { invalid, maybe, notFound, readBody } from "./validate";

export const staff = new Hono<AppEnv>();

export const INVITE_TTL = 7 * DAY;
const MAX_STAFF = 100;
const MAX_INVITES_PER_DAY = 20;

const LIVE = "accepted_at IS NULL AND revoked_at IS NULL";

staff.use("/staff/*", async (c, next) => ((await isOwner(c)) ? next() : c.json({ error: "forbidden" }, 403)));

staff.get("/staff", async (c) => {
  const firmId = c.get("firm").id;
  const db = c.env.CONTROL;
  const [people, invites] = await db.batch([
    db.prepare("SELECT id, email, name, role, created_at FROM users WHERE firm_id = ? AND disabled_at IS NULL ORDER BY created_at, id").bind(firmId),
    db.prepare(`SELECT id, email, name, created_at, expires_at FROM invites WHERE firm_id = ? AND ${LIVE} ORDER BY created_at DESC, id`).bind(firmId),
  ]);
  return c.json({ people: people.results, invites: invites.results });
});

// the invite stays when the email can't go out; the owner can send it again from the list
async function deliver(c: Context<AppEnv>, to: string): Promise<Response | null> {
  const firm = c.get("firm");
  const slot = await claimStaffMail(c.env, c.get("db"), firm.id);
  if (!slot) return c.json({ error: "email_limit" }, 429);
  const me = await c.env.CONTROL.prepare("SELECT name, email FROM users WHERE id = ?").bind(c.get("session")!.userId).first<{ name: string | null; email: string }>();
  try {
    await sendInviteEmail(c.env, to, me!.name ?? me!.email, firm.name!);
  } catch (e) {
    console.error(e instanceof Error ? e.message : "invite email failed");
    await c.get("db").prepare("DELETE FROM staff_mail WHERE id = ?").bind(slot).run();
    return c.json({ error: "email" }, 502);
  }
  return null;
}

staff.post("/staff/invites", async (c) => {
  const body = await readBody(c);
  if (!body) return invalid(c);
  const email = normalizeEmail(body.email);
  const name = maybe(body.name, 120);
  if (!email || name === undefined) return invalid(c);
  const firm = c.get("firm");
  if (!firm.name) return c.json({ error: "firm_profile" }, 400);
  const now = Date.now();
  if (!usable(firm, now)) return c.json({ error: "plan" }, 402);
  const db = c.env.CONTROL;
  // a removed member's row stays, and signing in under an invite brings it back
  const existing = await db.prepare("SELECT firm_id, role FROM users WHERE email = ? AND disabled_at IS NULL").bind(email).first<{ firm_id: string; role: string }>();
  // someone who signed in once and has nothing in their own account can still be invited
  if (existing && (existing.firm_id === firm.id || existing.role !== "owner" || !(await untouchedRegion(c.env, existing.firm_id, now)))) {
    return c.json({ error: "already_has_account" }, 409);
  }
  const id = randomId();
  const [, made] = await db.batch([
    db.prepare(`DELETE FROM invites WHERE firm_id = ? AND email = ? AND ${LIVE} AND expires_at <= ?`).bind(firm.id, email, now),
    db
      .prepare(
        `INSERT INTO invites (id, firm_id, email, name, invited_by, created_at, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE (SELECT COUNT(*) FROM invites WHERE firm_id = ?2 AND created_at > ?8) < ${MAX_INVITES_PER_DAY}
         AND (SELECT COUNT(*) FROM users WHERE firm_id = ?2 AND disabled_at IS NULL)
           + (SELECT COUNT(*) FROM invites WHERE firm_id = ?2 AND ${LIVE} AND expires_at > ?6) < ${MAX_STAFF}
         ON CONFLICT DO NOTHING`,
      )
      .bind(id, firm.id, email, name, c.get("session")!.userId, now, now + INVITE_TTL, now - DAY),
  ]);
  if (!made.meta.changes) {
    if (await db.prepare(`SELECT 1 FROM invites WHERE firm_id = ? AND email = ? AND ${LIVE}`).bind(firm.id, email).first()) {
      return c.json({ error: "already_invited" }, 409);
    }
    const { n } = (await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM users WHERE firm_id = ?1 AND disabled_at IS NULL)
           + (SELECT COUNT(*) FROM invites WHERE firm_id = ?1 AND ${LIVE} AND expires_at > ?2) AS n`,
      )
      .bind(firm.id, now)
      .first<{ n: number }>())!;
    return n >= MAX_STAFF ? c.json({ error: "too_many_staff" }, 409) : c.json({ error: "too_many_invites" }, 429);
  }
  await audit(c, "invite.send", "invite", id).run();
  return (await deliver(c, email)) ?? c.json({ id, email, name, created_at: now, expires_at: now + INVITE_TTL }, 201);
});

staff.post("/staff/invites/:id/resend", async (c) => {
  const firm = c.get("firm");
  if (!firm.name) return c.json({ error: "firm_profile" }, 400);
  const now = Date.now();
  if (!usable(firm, now)) return c.json({ error: "plan" }, 402);
  const id = c.req.param("id");
  // an expired invite is not in the count, so bringing it back has to fit under the cap again
  const row = await c.env.CONTROL.prepare(
    `UPDATE invites SET expires_at = ?1 WHERE id = ?2 AND firm_id = ?3 AND ${LIVE}
     AND (expires_at > ?4 OR (SELECT COUNT(*) FROM users WHERE firm_id = ?3 AND disabled_at IS NULL)
       + (SELECT COUNT(*) FROM invites WHERE firm_id = ?3 AND ${LIVE} AND expires_at > ?4) < ${MAX_STAFF}) RETURNING email`,
  )
    .bind(now + INVITE_TTL, id, firm.id, now)
    .first<{ email: string }>();
  if (!row) {
    const live = await c.env.CONTROL.prepare(`SELECT 1 FROM invites WHERE id = ? AND firm_id = ? AND ${LIVE}`).bind(id, firm.id).first();
    return live ? c.json({ error: "too_many_staff" }, 409) : notFound(c);
  }
  await audit(c, "invite.send", "invite", id, { resent: true }).run();
  return (await deliver(c, row.email)) ?? c.json({ ok: true });
});

staff.delete("/staff/invites/:id", async (c) => {
  const id = c.req.param("id");
  const res = await c.env.CONTROL.prepare(`UPDATE invites SET revoked_at = ? WHERE id = ? AND firm_id = ? AND ${LIVE}`).bind(Date.now(), id, c.get("firm").id).run();
  if (!res.meta.changes) return notFound(c);
  await audit(c, "invite.revoke", "invite", id).run();
  return c.json({ ok: true });
});

staff.delete("/staff/:id", async (c) => {
  const id = c.req.param("id");
  const firmId = c.get("firm").id;
  const db = c.env.CONTROL;
  const target = await db.prepare("SELECT id FROM users WHERE id = ? AND firm_id = ? AND disabled_at IS NULL").bind(id, firmId).first();
  if (!target) return notFound(c);
  if (id === c.get("session")!.userId) return c.json({ error: "cannot_remove_self" }, 409);
  const now = Date.now();
  // the owner count sits in the update so two owners removing each other can't both succeed
  const [res] = await db.batch([
    db
      .prepare(
        `UPDATE users SET disabled_at = ? WHERE id = ? AND firm_id = ? AND disabled_at IS NULL
         AND (role != 'owner' OR (SELECT COUNT(*) FROM users WHERE firm_id = ? AND role = 'owner' AND disabled_at IS NULL) > 1)`,
      )
      .bind(now, id, firmId, firmId),
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND disabled_at = ?)").bind(id, id, now),
  ]);
  if (!res.meta.changes) return c.json({ error: "last_owner" }, 409);
  await audit(c, "staff.remove", "user", id).run();
  return c.json({ ok: true });
});
