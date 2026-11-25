import { Hono } from "hono";
import { audit } from "./audit";
import { liveToken } from "./links";
import { MANUAL_SEQ, addressStopped, deliver, unsubUrl } from "./mail";
import type { Region } from "./regions";
import { findRequest } from "./requests";
import { canSend, missingItems, senderName, sendersOf } from "./reminders";
import type { AppEnv } from "./session";
import { DAY } from "./util";
import { notFound } from "./validate";

export const remind = new Hono<AppEnv>();

remind.get("/requests/:id/link", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const firm = c.get("firm");
  const live = await liveToken(c.env, c.get("db"), firm.id, req.id, Date.now());
  if (!live) return c.json({ url: null });
  await audit(c, "link.view", "request", req.id).run();
  return c.json({ url: `${c.env.APP_URL}/c/${live.token}`, expires_at: live.expires_at });
});

remind.post("/requests/:id/remind", async (c) => {
  const req = await findRequest(c);
  if (!req) return notFound(c);
  const firm = c.get("firm");
  const db = c.get("db");
  const now = Date.now();
  const [sender] = (await sendersOf(c.env, firm.region as Region, [firm.id])).values();
  if (!sender || !(sender.legal_name ?? sender.name)) return c.json({ error: "firm_profile" }, 400);
  if (!canSend(sender, now)) {
    if (!sender.address) return c.json({ error: "address_needed" }, 400);
    return sender.owner_email ? c.json({ error: "plan" }, 402) : c.json({ error: "sender_needed" }, 400);
  }
  if (req.status !== "open") return c.json({ error: "not_open" }, 409);

  const client = await db
    .prepare("SELECT name, email, email_ok_at, email_stop_at, email_bounced_at FROM clients WHERE firm_id = ? AND id = ? AND deleted_at IS NULL")
    .bind(firm.id, req.client_id)
    .first<{ name: string; email: string | null; email_ok_at: number | null; email_stop_at: number | null; email_bounced_at: number | null }>();
  if (!client?.email || !client.email_ok_at) return c.json({ error: "client_email_needed" }, 400);
  if (client.email_bounced_at) return c.json({ error: "client_bounced" }, 400);
  if (client.email_stop_at || (await addressStopped(c.env, db, firm.id, client.email))) return c.json({ error: "client_unsubscribed" }, 400);

  const live = await liveToken(c.env, db, firm.id, req.id, now);
  if (!live) return c.json({ error: "no_link" }, 409);
  const items = await missingItems(db, firm.id, req.id, false);
  if (!items.length) return c.json({ error: "nothing_missing" }, 409);

  const recent = await db
    .prepare("SELECT MAX(sent_at) AS at FROM messages WHERE firm_id = ? AND request_id = ? AND kind IN ('reminder', 'deadline') AND seq >= ? AND status IN ('sent', 'sending') AND sent_at > ?")
    .bind(firm.id, req.id, MANUAL_SEQ, now - DAY)
    .first<{ at: number | null }>();
  if (recent?.at) return c.json({ error: "too_soon", next_at: recent.at + DAY }, 429);

  const kind = now >= req.deadline ? "deadline" : "reminder";
  const last = await db
    .prepare("SELECT COALESCE(MAX(seq), ?) AS seq FROM messages WHERE firm_id = ? AND request_id = ? AND kind = ? AND seq >= ?")
    .bind(MANUAL_SEQ - 1, firm.id, req.id, kind, MANUAL_SEQ)
    .first<{ seq: number }>();
  const { outcome } = await deliver(
    c.env,
    { db, firmId: firm.id, requestId: req.id, clientId: req.client_id, kind, seq: last!.seq + 1 },
    {
      kind,
      sender: senderName(sender),
      address: sender.address,
      phone: sender.phone,
      replyTo: sender.owner_email,
      clientName: client.name,
      clientEmail: client.email,
      title: req.title,
      deadline: req.deadline,
      tz: sender.tz,
      items,
      url: `${c.env.APP_URL}/c/${live.token}`,
      unsubUrl: await unsubUrl(c.env, firm.region as Region, req.client_id, firm.id, client.email),
    },
    now,
  );
  if (outcome === "capped") return c.json({ error: "email_limit" }, 429);
  // another click took the same slot a moment ago
  if (outcome === "done" || outcome === "busy") return c.json({ error: "too_soon", next_at: now + DAY }, 429);
  if (outcome !== "sent") return c.json({ error: "email_failed" }, 502);
  await audit(c, "reminder.send", "request", req.id, { kind }).run();
  return c.json({ ok: true, sent_at: now });
});
