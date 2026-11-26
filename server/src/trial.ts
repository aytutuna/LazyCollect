import { classOf, itemFailed } from "./pulse";
import { Transient, escapeHtml, sendMail } from "./email";
import { asLang, longDate, textsFor, type Lang } from "./lang";
import { DAY, PAYING } from "./util";

export type TrialKind = "start" | "soon" | "end";

const SOON = 3 * DAY;
// an account whose trial ended longer ago than this is no longer told
const LATE = 7 * DAY;
const PER_RUN = 50;

type Trial = { id: string; tz: string; locale: string; trial_ends_at: number };

type Words = {
  soonOpen: string;
  kept: string;
  start: { subject: string; lines: (date: string, kept: string, soonOpen: string) => string[] };
  soon: { subject: (date: string) => string; lines: (date: string, kept: string, soonOpen: string) => string[] };
  end: { subject: string; lines: (date: string, kept: string, soonOpen: string) => string[] };
  subscribe: string;
  why: string;
};

const WORDS: Record<"en" | "fr-CA", Words> = {
  en: {
    soonOpen: "Payments are not open yet. They open soon, and we will email you when you can subscribe.",
    kept: "Your account and stored files are kept.",
    start: {
      subject: "Your Lazy Collect trial has started",
      lines: (date, kept, soonOpen) => [
        `Welcome to Lazy Collect. Your free trial runs until ${date}. Until then you can send requests and collect papers from your clients, and nothing is charged.`,
        soonOpen,
        `${kept} When the trial ends, new uploads from your clients pause.`,
      ],
    },
    soon: {
      subject: (date) => `Your Lazy Collect trial ends on ${date}`,
      lines: (date, kept, soonOpen) => [
        `Your free trial ends on ${date}.`,
        soonOpen,
        `${kept} When the trial ends, new uploads from your clients pause. They can still answer questions and write to you.`,
      ],
    },
    end: {
      subject: "Your Lazy Collect trial has ended",
      lines: (date, kept, soonOpen) => [
        `Your free trial ended on ${date}.`,
        `${kept} New uploads from your clients are paused. They can still answer questions and write to you.`,
        soonOpen,
      ],
    },
    subscribe: "Subscribe",
    why: "You are getting this because you are an owner of a Lazy Collect account.",
  },
  "fr-CA": {
    soonOpen: "Les paiements ne sont pas encore ouverts. Ils le seront bientôt, et nous vous enverrons un courriel quand vous pourrez vous abonner.",
    kept: "Votre compte et vos fichiers conservés sont gardés.",
    start: {
      subject: "Votre essai de Lazy Collect a commencé",
      lines: (date, kept, soonOpen) => [
        `Bienvenue dans Lazy Collect. Votre essai gratuit dure jusqu'au ${date}. D'ici là, vous pouvez envoyer des demandes et recueillir les documents de vos clients, sans aucuns frais.`,
        soonOpen,
        `${kept} À la fin de l'essai, les nouveaux envois de vos clients sont suspendus.`,
      ],
    },
    soon: {
      subject: (date) => `Votre essai de Lazy Collect se termine le ${date}`,
      lines: (date, kept, soonOpen) => [
        `Votre essai gratuit se termine le ${date}.`,
        soonOpen,
        `${kept} À la fin de l'essai, les nouveaux envois de vos clients sont suspendus. Ils peuvent encore répondre aux questions et vous écrire.`,
      ],
    },
    end: {
      subject: "Votre essai de Lazy Collect est terminé",
      lines: (date, kept, soonOpen) => [
        `Votre essai gratuit s'est terminé le ${date}.`,
        `${kept} Les nouveaux envois de vos clients sont suspendus. Ils peuvent encore répondre aux questions et vous écrire.`,
        soonOpen,
      ],
    },
    subscribe: "S'abonner",
    why: "Vous recevez ce message parce que vous êtes titulaire d'un compte Lazy Collect.",
  },
};

function letter(env: Env, kind: TrialKind, firm: Trial) {
  const lang = asLang(firm.locale);
  const w = textsFor(WORDS, lang);
  const date = longDate(firm.trial_ends_at, lang, firm.tz);
  const url = `${env.APP_URL}/settings`;
  const lines = w[kind].lines(date, w.kept, w.soonOpen);
  const subject = kind === "soon" ? w.soon.subject(date) : w[kind].subject;
  const colon = lang === "fr-CA" ? " :" : ":";
  const text = `${lines.join("\n\n")}\n\n${w.subscribe}${colon} ${url}\n\n${w.why}\n`;
  const html = `<!doctype html><html lang="${lang}"><body style="margin:0;padding:32px 16px;background:#f6f6f4;font-family:Arial,sans-serif;color:#1c1c1c">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
<p style="font-size:20px;margin:0 0 16px">Lazy Collect</p>
${lines.map((l) => `<p style="font-size:16px;margin:0 0 16px">${escapeHtml(l)}</p>`).join("\n")}
<p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#1c5d99;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">${w.subscribe}</a></p>
<p style="font-size:13px;line-height:1.5;color:#666666;margin:0">${w.why}</p>
</div></body></html>`;
  return { subject, text, html };
}

// To every owner of the account. The claim goes in before the email, so a repeat run skips an owner who has had it; a
// busy provider gives the claim back, a refusal does not, so one bad address is not tried every ten minutes.
export async function sendTrialNotice(env: Env, firm: Trial, kind: TrialKind) {
  const { results: owners } = await env.CONTROL.prepare("SELECT id, email FROM users WHERE firm_id = ? AND role = 'owner' AND disabled_at IS NULL")
    .bind(firm.id)
    .all<{ id: string; email: string }>();
  const { subject, text, html } = letter(env, kind, firm);
  for (const owner of owners) {
    const claim = await env.CONTROL.prepare("INSERT OR IGNORE INTO trial_notices (firm_id, user_id, kind, trial_ends_at, sent_at) VALUES (?, ?, ?, ?, ?)")
      .bind(firm.id, owner.id, kind, firm.trial_ends_at, Date.now())
      .run();
    if (claim.meta.changes !== 1) continue;
    try {
      await sendMail(env, { from: env.EMAIL_FROM, to: owner.email, subject, text, html, idempotencyKey: `trial:${firm.id}:${owner.id}:${kind}` });
    } catch (e) {
      console.error(e instanceof Error ? e.message : "error");
      itemFailed(e instanceof Transient ? "EmailDeferred" : "EmailRefused");
      if (e instanceof Transient) await env.CONTROL.prepare("DELETE FROM trial_notices WHERE firm_id = ? AND user_id = ? AND kind = ? AND trial_ends_at = ?").bind(firm.id, owner.id, kind, firm.trial_ends_at).run();
    }
  }
}

// The 3-days-before and the ended emails, for trials nobody has subscribed to. The sign-up email goes out when the
// account is made, so accounts that already exist are never sent one.
export async function runTrialNotices(env: Env, now = Date.now()) {
  const due = (kind: TrialKind, from: number, to: number) =>
    env.CONTROL.prepare(
      `SELECT id, tz, locale, trial_ends_at FROM firms
       WHERE plan_status = 'trialing' AND NOT ${PAYING} AND closed_at IS NULL AND trial_ends_at > ? AND trial_ends_at <= ?
       AND EXISTS (SELECT 1 FROM users u WHERE u.firm_id = firms.id AND u.role = 'owner' AND u.disabled_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM trial_notices n WHERE n.firm_id = firms.id AND n.user_id = u.id AND n.kind = ? AND n.trial_ends_at = firms.trial_ends_at))
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
        itemFailed(classOf(e));
      }
    }
  }
}
