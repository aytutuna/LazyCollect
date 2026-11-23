import { sendMail } from "./email";
import { usable } from "./firm";
import { linkUrl } from "./links";
import { deliver, stopHash, unsubUrl, type Missing } from "./mail";
import { regionIds, regionOf, type Region } from "./regions";
import { SPACING, dayOf, inHours, nextOpening, nextReminder, sameDay } from "./tz";
import { DAY, HOUR, MINUTE } from "./util";

const MAX_NOTICE_TRIES = 3;

const BATCH = 100;
const REJECT_QUIET = 10 * MINUTE;

export type Sender = {
  id: string;
  name: string | null;
  legal_name: string | null;
  address: string | null;
  phone: string | null;
  tz: string;
  plan_status: string;
  trial_ends_at: number | null;
  past_due_since: number | null;
  closed_at: number | null;
  owner_email: string | null;
};

export async function sendersOf(env: Env, region: Region, ids: string[]): Promise<Map<string, Sender>> {
  const { results } = await env.CONTROL.prepare(
    `SELECT f.id, f.name, f.legal_name, f.address, f.phone, f.tz, f.plan_status, f.trial_ends_at, f.past_due_since, f.closed_at,
       (SELECT email FROM users WHERE firm_id = f.id AND role = 'owner' AND disabled_at IS NULL ORDER BY created_at LIMIT 1) AS owner_email
     FROM firms f WHERE f.region = ? AND f.id IN (SELECT value FROM json_each(?))`,
  )
    .bind(region, JSON.stringify([...new Set(ids)]))
    .all<Sender>();
  return new Map(results.map((s) => [s.id, s]));
}

export const senderName = (s: Sender) => (s.legal_name ?? s.name)!;

// an account sends only as itself: a name, a mailing address and an owner to reply to
export const canSend = (s: Sender | undefined, now: number): s is Sender & { address: string; owner_email: string } =>
  Boolean(s && (s.legal_name ?? s.name) && s.address && s.owner_email && usable(s, now));

export async function missingItems(db: D1Database, firmId: string, requestId: string, onlyRejected: boolean): Promise<Missing[]> {
  const { results } = await db
    .prepare(
      `SELECT label, required, reject_note FROM items WHERE firm_id = ? AND request_id = ?
       AND status IN (${onlyRejected ? "'rejected'" : "'empty', 'rejected'"}) ORDER BY required DESC, position`,
    )
    .bind(firmId, requestId)
    .all<{ label: string; required: number; reject_note: string | null }>();
  return results.map((i) => ({ ...i, required: i.required === 1 }));
}

type Row = {
  id: string;
  firm_id: string;
  client_id: string;
  title: string;
  deadline: number;
  seq: number;
  mark: number | null;
  client_name: string;
  email: string | null;
  email_ok_at: number | null;
  email_stop_at: number | null;
  client_deleted: number | null;
  stopped?: boolean;
};

const ROW = `r.id, r.firm_id, r.client_id, r.title, r.deadline, c.name AS client_name, c.email, c.email_ok_at, c.email_stop_at, c.deleted_at AS client_deleted`;
const JOIN = `FROM requests r JOIN clients c ON c.firm_id = r.firm_id AND c.id = r.client_id`;

const reachable = (r: Row) => Boolean(r.email && r.email_ok_at && !r.email_stop_at && !r.stopped && !r.client_deleted);

// an address that asked to stop stays stopped for the account, whatever client row holds it now
async function markStops(env: Env, db: D1Database, rows: Row[]) {
  const hashes = await Promise.all(rows.map((r) => (r.email ? stopHash(env, r.email) : null)));
  const { results } = await db
    .prepare("SELECT firm_id, email_hash FROM email_stops WHERE firm_id IN (SELECT value FROM json_each(?)) AND email_hash IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...new Set(rows.map((r) => r.firm_id))]), JSON.stringify(hashes.filter(Boolean)))
    .all<{ firm_id: string; email_hash: string }>();
  const stopped = new Set(results.map((s) => `${s.firm_id}:${s.email_hash}`));
  rows.forEach((r, i) => {
    r.stopped = hashes[i] !== null && stopped.has(`${r.firm_id}:${hashes[i]}`);
  });
}

export async function runReminders(env: Env, now = Date.now()) {
  for (const region of regionIds) {
    const { db } = regionOf(env, region);
    await remindPass(env, region, db, now);
    await rejectedPass(env, region, db, now);
    await noticePass(env, db, now);
  }
}

// one request failing must not hold back the rest of the batch
async function each<T>(rows: T[], fn: (row: T) => Promise<unknown>) {
  for (const row of rows) {
    try {
      await fn(row);
    } catch (e) {
      console.error(e instanceof Error ? e.message : "error");
    }
  }
}

// the sender list was read before the loop; a close or a lapse in between must still stop the email
async function stillUsable(env: Env, firmId: string, now: number) {
  const f = await env.CONTROL.prepare("SELECT plan_status, trial_ends_at, past_due_since, closed_at FROM firms WHERE id = ?").bind(firmId).first<Parameters<typeof usable>[0]>();
  return Boolean(f && usable(f, now));
}

async function remindPass(env: Env, region: Region, db: D1Database, now: number) {
  const { results } = await db
    .prepare(
      `SELECT ${ROW}, r.reminder_seq AS seq ${JOIN}
       WHERE r.next_reminder_at <= ? AND r.status = 'open' AND r.reminders_on = 1 AND r.deleted_at IS NULL
       ORDER BY r.next_reminder_at LIMIT ${BATCH}`,
    )
    .bind(now)
    .all<Row>();
  await markStops(env, db, results);
  const senders = await sendersOf(env, region, results.map((r) => r.firm_id));

  let busy = false;
  await each(results, async (r) => {
    if (busy) return;
    const sender = senders.get(r.firm_id);
    const move = (to: number | null) =>
      db.prepare("UPDATE requests SET next_reminder_at = ? WHERE firm_id = ? AND id = ? AND reminder_seq = ?").bind(to, r.firm_id, r.id, r.seq).run();
    if (!sender || r.email_stop_at || r.client_deleted) return move(null);
    // missing contact details can be fixed later, so the request stays in the cadence
    if (!reachable(r) || !canSend(sender, now)) return move(now + DAY);
    const tz = sender.tz;
    if (!inHours(now, tz)) return move(nextOpening(now, tz));
    // a client hears from us at most once in 36 hours; the note after the deadline closes things out, and the deadline morning may follow the reminder two days before
    const kind = now >= r.deadline ? "deadline" : "reminder";
    if (kind === "reminder") {
      const recent = await db
        .prepare(
          `SELECT request_id, sent_at FROM messages WHERE firm_id = ? AND client_id = ? AND kind IN ('reminder', 'deadline') AND status IN ('sent', 'sending') AND sent_at > ?
           ORDER BY sent_at DESC LIMIT 1`,
        )
        .bind(r.firm_id, r.client_id, now - SPACING)
        .first<{ request_id: string; sent_at: number }>();
      const morning = sameDay(dayOf(now, tz), dayOf(r.deadline, tz));
      if (recent && !(recent.request_id === r.id && morning)) return move(nextOpening(recent.sent_at + SPACING - 1, tz));
    }

    const items = await missingItems(db, r.firm_id, r.id, false);
    if (!items.length) return move(null);
    if (!(await stillUsable(env, r.firm_id, now))) return move(now + DAY);
    const slot = { db, firmId: r.firm_id, requestId: r.id, clientId: r.client_id, kind, seq: r.seq + 1 } as const;
    const { outcome } = await deliver(
      env,
      slot,
      {
        kind,
        sender: senderName(sender),
        address: sender.address,
        phone: sender.phone,
        replyTo: sender.owner_email,
        clientName: r.client_name,
        clientEmail: r.email!,
        title: r.title,
        deadline: r.deadline,
        tz,
        items,
        url: await linkUrl(env, db, region, r.firm_id, r.id, r.deadline, now),
        unsubUrl: await unsubUrl(env, region, r.client_id, r.firm_id),
      },
      now,
    );
    // over the daily cap: not sent, so it stays due and is looked at again later
    if (outcome === "capped") return move(now + HOUR);
    if (outcome === "later") busy = true;
    if (outcome === "failed" || outcome === "busy" || outcome === "later") return;
    await db
      .prepare("UPDATE requests SET reminder_seq = ?, next_reminder_at = ? WHERE firm_id = ? AND id = ? AND reminder_seq = ?")
      .bind(r.seq + 1, kind === "deadline" ? null : nextReminder(now, r.deadline, tz, false), r.firm_id, r.id, r.seq)
      .run();
  });
}

// Rejections are held for a quiet spell so several in a row go out as one email.
async function rejectedPass(env: Env, region: Region, db: D1Database, now: number) {
  const { results } = await db
    .prepare(
      `SELECT ${ROW}, r.rejected_seq AS seq, r.reject_mark_at AS mark, r.status ${JOIN}
       WHERE r.reject_mark_at <= ? AND r.deleted_at IS NULL ORDER BY r.reject_mark_at LIMIT ${BATCH}`,
    )
    .bind(now - REJECT_QUIET)
    .all<Row & { status: string }>();
  await markStops(env, db, results);
  const senders = await sendersOf(env, region, results.map((r) => r.firm_id));

  let busy = false;
  await each(results, async (r) => {
    if (busy) return;
    const sender = senders.get(r.firm_id);
    const clear = () =>
      db.prepare("UPDATE requests SET reject_mark_at = NULL WHERE firm_id = ? AND id = ? AND reject_mark_at = ?").bind(r.firm_id, r.id, r.mark).run();
    // a mark in the future is how a row waits: it leaves the head of the queue instead of blocking the accounts behind it
    const hold = (until: number) =>
      db.prepare("UPDATE requests SET reject_mark_at = ? WHERE firm_id = ? AND id = ? AND reject_mark_at = ?").bind(until - REJECT_QUIET, r.firm_id, r.id, r.mark).run();
    if (!sender || !reachable(r) || !canSend(sender, now) || (r.status !== "open" && r.status !== "complete")) return clear();
    if (!inHours(now, sender.tz)) return hold(nextOpening(now, sender.tz));
    const items = await missingItems(db, r.firm_id, r.id, true);
    if (!items.length) return clear();
    if (!(await stillUsable(env, r.firm_id, now))) return clear();
    const { outcome } = await deliver(
      env,
      { db, firmId: r.firm_id, requestId: r.id, clientId: r.client_id, kind: "rejected", seq: r.seq + 1 },
      {
        kind: "rejected",
        sender: senderName(sender),
        address: sender.address,
        phone: sender.phone,
        replyTo: sender.owner_email,
        clientName: r.client_name,
        clientEmail: r.email!,
        title: r.title,
        deadline: r.deadline,
        tz: sender.tz,
        items,
        url: await linkUrl(env, db, region, r.firm_id, r.id, r.deadline, now),
        unsubUrl: await unsubUrl(env, region, r.client_id, r.firm_id),
      },
      now,
    );
    if (outcome === "capped") return hold(now + HOUR);
    if (outcome === "later") busy = true;
    if (outcome === "failed" || outcome === "busy" || outcome === "later") return;
    await db
      .prepare(
        `UPDATE requests SET rejected_seq = ?, reject_mark_at = CASE WHEN reject_mark_at = ? THEN NULL ELSE reject_mark_at END
         WHERE firm_id = ? AND id = ? AND rejected_seq = ?`,
      )
      .bind(r.seq + 1, r.mark, r.firm_id, r.id, r.seq)
      .run();
  });
}

// The account hears about uploads at most once an hour per request, as one count of what came in since the last note.
async function noticePass(env: Env, db: D1Database, now: number) {
  const { results } = await db
    .prepare(
      `SELECT r.id, r.firm_id, r.title, r.notified_at, r.notice_due_at AS due, r.notice_tries AS tries, c.name AS client_name,
         (SELECT COUNT(*) FROM files f WHERE f.firm_id = r.firm_id AND f.request_id = r.id AND f.uploaded_by = 'client'
           AND f.state = 'live' AND f.deleted_at IS NULL AND f.uploaded_at > COALESCE(r.notified_at, 0)) AS n
       ${JOIN} WHERE r.notice_due_at IS NOT NULL AND (r.notified_at IS NULL OR r.notified_at <= ?) AND r.deleted_at IS NULL
       ORDER BY r.notice_due_at LIMIT ${BATCH}`,
    )
    .bind(now - HOUR)
    .all<{ id: string; firm_id: string; title: string; notified_at: number | null; due: number; tries: number; client_name: string; n: number }>();
  const owners = await ownersOf(env, results.map((r) => r.firm_id));

  await each(results, async (r) => {
    const claimed = await db
      .prepare("UPDATE requests SET notified_at = ?, notice_due_at = NULL WHERE firm_id = ? AND id = ? AND notice_due_at = ?")
      .bind(now, r.firm_id, r.id, r.due)
      .run();
    const to = owners.get(r.firm_id);
    if (claimed.meta.changes !== 1 || !to || !r.n) return;
    const what = `${r.client_name} uploaded ${r.n} ${r.n === 1 ? "document" : "documents"} to ${r.title}`;
    try {
      await sendMail(env, {
        from: env.EMAIL_FROM,
        to,
        subject: what.replace(/[\r\n]+/g, " "),
        text: `${what}.\n\nOpen it here:\n${env.APP_URL}/requests/${r.id}\n`,
      });
    } catch (e) {
      const tries = r.tries + 1;
      const spent = tries >= MAX_NOTICE_TRIES;
      console.error(`owner notice ${tries}/${MAX_NOTICE_TRIES} failed: ${e instanceof Error ? e.message : "error"}`);
      // put the note back so the next run tries again, until the tries are used up
      await db
        .prepare("UPDATE requests SET notified_at = ?, notice_due_at = ?, notice_tries = ? WHERE firm_id = ? AND id = ?")
        .bind(spent ? now : r.notified_at, spent ? null : r.due, spent ? 0 : tries, r.firm_id, r.id)
        .run();
    }
  });
}

async function ownersOf(env: Env, ids: string[]): Promise<Map<string, string>> {
  const { results } = await env.CONTROL.prepare(
    `SELECT firm_id, email FROM users WHERE role = 'owner' AND disabled_at IS NULL AND firm_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC`,
  )
    .bind(JSON.stringify([...new Set(ids)]))
    .all<{ firm_id: string; email: string }>();
  return new Map(results.map((u) => [u.firm_id, u.email]));
}
