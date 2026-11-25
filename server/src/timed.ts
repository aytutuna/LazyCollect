import { purgeClosed } from "./account";
import { runBatches } from "./batches";
import { sendMail } from "./email";
import { purgeExpired } from "./purge";
import { classOf, collect, endCollect } from "./pulse";
import { runReminders } from "./reminders";
import { sweepFiles } from "./sweep";
import { runTrialNotices } from "./trial";
import { DAY, HOUR } from "./util";

export const ALERT_TO = "support@alazy.app";

// a step that keeps failing is mailed about once an hour
const ALERT_EVERY = HOUR;

export type Step = [name: string, run: (env: Env, now: number) => Promise<unknown>];

export const steps: Step[] = [
  [
    "cleanup",
    (env, now) =>
      env.CONTROL.batch([
        env.CONTROL.prepare("DELETE FROM login_codes WHERE created_at < ?").bind(now - DAY),
        env.CONTROL.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
        env.CONTROL.prepare("DELETE FROM client_sessions WHERE expires_at < ?").bind(now),
        env.CONTROL.prepare("DELETE FROM app_challenges WHERE expires_at < ?").bind(now),
        env.CONTROL.prepare("DELETE FROM pending_logins WHERE expires_at < ?").bind(now),
        env.CONTROL.prepare("DELETE FROM passkey_challenges WHERE expires_at < ?").bind(now),
        env.CONTROL.prepare("DELETE FROM stripe_events WHERE received_at < ?").bind(now - 30 * DAY),
      ]),
  ],
  ["files", sweepFiles],
  ["purge", purgeExpired],
  ["closed", purgeClosed],
  ["batches", runBatches],
  ["reminders", runReminders],
  ["trial", runTrialNotices],
];

const message = (e: unknown) => (e instanceof Error ? e.message : "error");

// one failing step must not stop the others; only the message is logged
export async function runTimed(env: Env, now = Date.now(), list: Step[] = steps) {
  const failed: { name: string; error: string }[] = [];
  for (const [name, run] of list) {
    collect();
    let error: string | null = null;
    try {
      await run(env, now);
    } catch (e) {
      console.error(message(e));
      error = classOf(e);
    }
    // items that failed inside a step that went through count against it too
    const items = Object.entries(endCollect()).map(([kind, n]) => `${kind} x${n}`);
    if (error || items.length) failed.push({ name, error: [error, ...items].filter(Boolean).join(", ") });
  }
  try {
    await record(env, now, list, failed);
  } catch (e) {
    console.error(message(e));
  }
}

async function record(env: Env, now: number, list: Step[], failed: { name: string; error: string }[]) {
  const bad = new Set(failed.map((f) => f.name));
  // a step that works again may be mailed about the next time it fails
  const upsert = "INSERT INTO timed_status (step, ok_at) VALUES (?1, ?2) ON CONFLICT (step) DO UPDATE SET ok_at = ?2, alerted_at = NULL";
  await env.CONTROL.batch([
    ...list.filter(([name]) => !bad.has(name)).map(([name]) => env.CONTROL.prepare(upsert).bind(name, now)),
    ...failed.map((f) =>
      env.CONTROL.prepare("INSERT INTO timed_status (step, failed_at, error) VALUES (?1, ?2, ?3) ON CONFLICT (step) DO UPDATE SET failed_at = ?2, error = ?3").bind(f.name, now, f.error),
    ),
    ...(failed.length ? [] : [env.CONTROL.prepare(upsert).bind("run", now)]),
  ]);
  const due = [];
  for (const f of failed) {
    // claimed before the email, so two runs at once send one
    const claim = await env.CONTROL.prepare("UPDATE timed_status SET alerted_at = ? WHERE step = ? AND (alerted_at IS NULL OR alerted_at <= ?)").bind(now, f.name, now - ALERT_EVERY).run();
    if (claim.meta.changes === 1) due.push(f);
  }
  if (!due.length) return;
  const text = `${due.map((f) => `${f.name}: ${f.error}`).join("\n")}\n\nThe timed run of ${env.APP_URL} had these steps fail at ${new Date(now).toISOString()}. The others ran. Only the kind of error is listed here; the worker's logs have the rest.\n`;
  await sendMail(env, { from: env.EMAIL_FROM, to: ALERT_TO, subject: `Lazy Collect: timed run failed (${due.map((f) => f.name).join(", ")})`, text });
}

// the answer for the watch job: when every step last worked
export async function lastGoodRun(env: Env, now = Date.now()) {
  const row = await env.CONTROL.prepare("SELECT ok_at FROM timed_status WHERE step = 'run'").first<{ ok_at: number }>();
  return { last_good_run: row?.ok_at ?? null, age_minutes: row ? Math.floor((now - row.ok_at) / 60_000) : null };
}
