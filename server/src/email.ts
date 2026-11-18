import { FETCH_TIMEOUT_MS } from "./util";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export async function sendLoginEmail(env: Env, to: string, code: string, link: string): Promise<void> {
  const subject = "Your Lazy Collect sign-in code";
  const text = `Your sign-in code is ${code}\n\nOr open this link to sign in:\n${link}\n\nThe code and link work once and expire in 10 minutes.\nIf you didn't ask for this, you can ignore this email.\n`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;padding:32px 16px;background:#f6f6f4;font-family:Arial,sans-serif;color:#1c1c1c">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
<p style="font-size:20px;margin:0 0 16px">Lazy Collect</p>
<p style="font-size:16px;margin:0 0 16px">Your sign-in code:</p>
<p style="font-family:'Courier New',monospace;font-size:32px;letter-spacing:8px;font-weight:bold;margin:0 0 24px">${code}</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1c5d99;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:15px">Sign in</a></p>
<p style="font-size:13px;line-height:1.5;color:#666666;margin:0">The code and link work once and expire in 10 minutes.<br>If you didn't ask for this, you can ignore this email.</p>
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
