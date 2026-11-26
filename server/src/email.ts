import { textsFor, type Lang } from "./lang";
import { FETCH_TIMEOUT_MS } from "./util";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const LOGIN = {
  en: {
    subject: "Your Lazy Collect sign-in code",
    text: (code: string, link: string) =>
      `Your sign-in code is ${code}\n\nOr open this link to sign in:\n${link}\n\nThe code and link work once and expire in 10 minutes. Only the newest email works.\nIf you didn't ask for this, you can ignore this email.\n`,
    lead: "Your sign-in code:",
    button: "Sign in",
    small: "The code and link work once and expire in 10 minutes. Only the newest email works.<br>If you didn't ask for this, you can ignore this email.",
  },
  "fr-CA": {
    subject: "Votre code de connexion Lazy Collect",
    text: (code: string, link: string) =>
      `Votre code de connexion est ${code}\n\nOu ouvrez ce lien pour vous connecter :\n${link}\n\nLe code et le lien ne fonctionnent qu'une fois et expirent dans 10 minutes. Seul le courriel le plus récent fonctionne.\nSi vous n'avez pas fait cette demande, vous pouvez ignorer ce courriel.\n`,
    lead: "Votre code de connexion :",
    button: "Se connecter",
    small: "Le code et le lien ne fonctionnent qu'une fois et expirent dans 10 minutes. Seul le courriel le plus récent fonctionne.<br>Si vous n'avez pas fait cette demande, vous pouvez ignorer ce courriel.",
  },
} as const;

export async function sendLoginEmail(env: Env, to: string, code: string, link: string, lang: Lang = "en"): Promise<void> {
  const w = textsFor(LOGIN, lang);
  const subject = w.subject;
  const text = w.text(code, link);
  const html = `<!doctype html><html lang="${lang}"><body style="margin:0;padding:32px 16px;background:#f6f6f4;font-family:Arial,sans-serif;color:#1c1c1c">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
<p style="font-size:20px;margin:0 0 16px">Lazy Collect</p>
<p style="font-size:16px;margin:0 0 16px">${w.lead}</p>
<p style="font-family:'Courier New',monospace;font-size:32px;letter-spacing:8px;font-weight:bold;margin:0 0 24px">${code}</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1c5d99;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">${w.button}</a></p>
<p style="font-size:13px;line-height:1.5;color:#666666;margin:0">${w.small}</p>
</div></body></html>`;
  let res: Response;
  try {
    res = await fetch(`${env.RESEND_BASE ?? "https://api.resend.com"}/emails`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`login email request failed: ${e instanceof Error ? e.name : "error"}`);
  }
  if (!res.ok) throw new Error(`login email rejected: HTTP ${res.status}`);
}

// the provider is busy or down: the message was not refused, so the attempt should not count
export class Transient extends Error {}

export type Outgoing = { from: string; to: string; replyTo?: string; subject: string; text: string; html?: string; headers?: Record<string, string>; idempotencyKey?: string };

// resolves to the provider's id for the message
export async function sendMail(env: Env, m: Outgoing): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${env.RESEND_BASE ?? "https://api.resend.com"}/emails`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        ...(m.idempotencyKey && { "idempotency-key": m.idempotencyKey }),
      },
      body: JSON.stringify({ from: m.from, to: [m.to], reply_to: m.replyTo, subject: m.subject, text: m.text, html: m.html, headers: m.headers }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // a timeout or a dropped connection is the provider being out of reach, not a refusal of this message
    throw new Transient(`email request failed: ${e instanceof Error ? e.name : "error"}`);
  }
  // a reused key means an earlier attempt of this slot was accepted
  if (res.status === 409 && m.idempotencyKey) return null;
  if (res.status === 429 || res.status >= 500) throw new Transient(`email deferred: HTTP ${res.status}`);
  if (!res.ok) throw new Error(`email rejected: HTTP ${res.status}`);
  const body = await res.json<{ id?: string }>().catch(() => null);
  return body?.id ?? null;
}

const INVITE = {
  en: {
    subject: (who: string, place: string) => `${who} invited you to ${place} on Lazy Collect`,
    line: (who: string, place: string) => `${who} invited you to ${place} on Lazy Collect.`,
    text: (url: string) => `Sign in with this email address to join:\n${url}\n\nThe invitation expires in 7 days.\nIf you weren't expecting it, you can ignore this email.\n`,
    button: "Sign in to join",
    small: "Sign in with this email address. The invitation expires in 7 days.<br>If you weren't expecting it, you can ignore this email.",
  },
  "fr-CA": {
    subject: (who: string, place: string) => `${who} vous a invité à vous joindre à ${place} sur Lazy Collect`,
    line: (who: string, place: string) => `${who} vous a invité à vous joindre à ${place} sur Lazy Collect.`,
    text: (url: string) => `Connectez-vous avec cette adresse courriel pour vous joindre :\n${url}\n\nL'invitation expire dans 7 jours.\nSi vous ne l'attendiez pas, vous pouvez ignorer ce courriel.\n`,
    button: "Se connecter pour se joindre",
    small: "Connectez-vous avec cette adresse courriel. L'invitation expire dans 7 jours.<br>Si vous ne l'attendiez pas, vous pouvez ignorer ce courriel.",
  },
} as const;

export async function sendInviteEmail(env: Env, to: string, inviter: string, account: string, lang: Lang = "en"): Promise<void> {
  const w = textsFor(INVITE, lang);
  const who = inviter.replace(/[\r\n]+/g, " ").trim();
  const place = account.replace(/[\r\n]+/g, " ").trim();
  const subject = w.subject(who, place);
  const text = `${w.line(who, place)}\n\n${w.text(`${env.APP_URL}/`)}`;
  const html = `<!doctype html><html lang="${lang}"><body style="margin:0;padding:32px 16px;background:#f6f6f4;font-family:Arial,sans-serif;color:#1c1c1c">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
<p style="font-size:20px;margin:0 0 16px">Lazy Collect</p>
<p style="font-size:16px;margin:0 0 24px">${escapeHtml(w.line(who, place))}</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(env.APP_URL)}/" style="display:inline-block;background:#1c5d99;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">${w.button}</a></p>
<p style="font-size:13px;line-height:1.5;color:#666666;margin:0">${w.small}</p>
</div></body></html>`;
  await sendMail(env, { from: env.EMAIL_FROM, to, subject, text, html });
}
