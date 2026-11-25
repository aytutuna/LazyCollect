import { Transient, escapeHtml, sendMail } from "./email";
import { DAY } from "./util";

export type TrialKind = "start" | "soon" | "end";

const SOON = 3 * DAY;
// an account whose trial ended longer ago than this is no longer told
const LATE = 7 * DAY;
const PER_RUN = 50;

type Trial = { id: string; tz: string; trial_ends_at: number };

function letter(env: Env, kind: TrialKind, firm: Trial) {
  const date = new Intl.DateTimeFormat("en-CA", { dateStyle: "long", timeZone: firm.tz }).format(firm.trial_ends_at);
  const url = `${env.APP_URL}/settings`;
  const paying = "Paying on the site is being opened in full over the next days.";
  const copy = {
    start: {
      subject: "Your Lazy Collect trial has started",
      lines: [
        `Welcome to Lazy Collect. Your free trial runs until ${date}. You can send requests and collect papers from your clients until then, and nothing is charged unless you subscribe.`,
        `Subscribe at any time to keep going after ${date}.`,
      ],
    },
    soon: {
      subject: `Your Lazy Collect trial ends on ${date}`,
      lines: [
        `Your free trial ends on ${date}, in 3 days.`,
        "If you subscribe by then, nothing changes. If not, your clients' links stop taking new files from then on. They can still answer questions and write to you, and your papers stay saved for your retention period. Subscribing opens the links again.",
        paying,
      ],
    },
    end: {
      subject: "Your Lazy Collect trial has ended",
      lines: [
        `Your free trial ended on ${date}.`,
        `New files from your clients are paused. Their links still show the checklist and take answers and messages, and your papers stay saved for your retention period. Subscribing opens the links again.`,
        paying,
      ],
    },
  }[kind];
  const text = `${copy.lines.join("\n\n")}\n\nSubscribe: ${url}\n\nYou are getting this because you are an owner of a Lazy Collect account.\n`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;padding:32px 16px;background:#f6f6f4;font-family:Arial,sans-serif;color:#1c1c1c">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
<p style="font-size:20px;margin:0 0 16px">Lazy Collect</p>
${copy.lines.map((l) => `<p style="font-size:16px;margin:0 0 16px">${escapeHtml(l)}</p>`).join("\n")}
<p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1c5d99;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">Subscribe</a></p>
<p style="font-size:13px;line-height:1.5;color:#666666;margin:0">You are getting this because you are an owner of a Lazy Collect account.</p>
</div></body></html>`;
  return { subject: copy.subject, text, html };
}

// To every owner of the account. The claim goes in before the email, so a repeat run skips an owner who has had it; a
// busy provider gives the claim back, a refusal does not, so one bad address is not tried every ten minutes.
export async function sendTrialNotice(env: Env, firm: Trial, kind: TrialKind) {
  const { results: owners } = await env.CONTROL.prepare("SELECT id, email FROM users WHERE firm_id = ? AND role = 'owner' AND disabled_at IS NULL")
    .bind(firm.id)
    .all<{ id: string; email: string }>();
  const { subject, text, html } = letter(env, kind, firm);
  for (const owner of owners) {
    const claim = await env.CONTROL.prepare("INSERT OR IGNORE INTO trial_notices (firm_id, user_id, kind, sent_at) VALUES (?, ?, ?, ?)")
      .bind(firm.id, owner.id, kind, Date.now())
      .run();
    if (claim.meta.changes !== 1) continue;
    try {
      await sendMail(env, { from: env.EMAIL_FROM, to: owner.email, subject, text, html, idempotencyKey: `trial:${firm.id}:${owner.id}:${kind}` });
    } catch (e) {
      console.error(e instanceof Error ? e.message : "error");
      if (e instanceof Transient) await env.CONTROL.prepare("DELETE FROM trial_notices WHERE firm_id = ? AND user_id = ? AND kind = ?").bind(firm.id, owner.id, kind).run();
    }
  }
}

// The 3-days-before and the ended emails, for trials nobody has subscribed to. The sign-up email goes out when the
// account is made, so accounts that already exist are never sent one.
export async function runTrialNotices(env: Env, now = Date.now()) {
  const due = (kind: TrialKind, from: number, to: number) =>
    env.CONTROL.prepare(
      `SELECT id, tz, trial_ends_at FROM firms
       WHERE plan_status = 'trialing' AND stripe_subscription_id IS NULL AND closed_at IS NULL AND trial_ends_at > ? AND trial_ends_at <= ?
       AND EXISTS (SELECT 1 FROM users u WHERE u.firm_id = firms.id AND u.role = 'owner' AND u.disabled_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM trial_notices n WHERE n.firm_id = firms.id AND n.user_id = u.id AND n.kind = ?))
       ORDER BY trial_ends_at LIMIT ?`,
    )
      .bind(from, to, kind, PER_RUN)
      .all<Trial>();
  for (const [kind, from, to] of [["soon", now, now + SOON], ["end", now - LATE, now]] as const) {
    for (const firm of (await due(kind, from, to)).results) {
      try {
        await sendTrialNotice(env, firm, kind);
      } catch (e) {
        console.error(e instanceof Error ? e.message : "error");
      }
    }
  }
}
