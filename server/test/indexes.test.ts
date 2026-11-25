import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// Each query the timed run and the email limits depend on, with the index that has to answer it. A plan that only
// scans the table fails here, since these run every minute or every few minutes against every account's rows.
const control: [string, string, string][] = [
  ["clear old sign-in codes", "DELETE FROM login_codes WHERE created_at < 0", "idx_login_codes_created"],
  ["clear ended sessions", "DELETE FROM sessions WHERE expires_at < 0", "idx_sessions_expires"],
  ["clear ended client sessions", "DELETE FROM client_sessions WHERE expires_at < 0", "idx_client_sessions_expires"],
  ["clear device checks", "DELETE FROM app_challenges WHERE expires_at < 0", "idx_app_challenges_expires"],
  ["clear pending sign-ins", "DELETE FROM pending_logins WHERE expires_at < 0", "idx_pending_logins_expires"],
  ["clear passkey challenges", "DELETE FROM passkey_challenges WHERE expires_at < 0", "idx_passkey_challenges_expires"],
  ["clear old payment events", "DELETE FROM stripe_events WHERE received_at < 0", "idx_stripe_events_received"],
  [
    "trials about to end",
    "SELECT id FROM firms WHERE plan_status = 'trialing' AND stripe_subscription_id IS NULL AND closed_at IS NULL AND trial_ends_at > 0 AND trial_ends_at <= 1",
    "idx_firms_trialing",
  ],
  ["closed accounts due for purge", "SELECT id FROM firms WHERE closed_at IS NOT NULL AND closed_at <= 0 ORDER BY closed_at LIMIT 5", "idx_firms_closed"],
  ["an account's owner", "SELECT email FROM users WHERE firm_id = 'f' AND role = 'owner' ORDER BY created_at LIMIT 1", "idx_users_firm"],
];

const na: [string, string, string][] = [
  ["requests due a reminder", "SELECT id FROM requests WHERE next_reminder_at <= 0 AND status = 'open' AND reminders_on = 1 AND deleted_at IS NULL ORDER BY next_reminder_at LIMIT 60", "idx_requests_reminder"],
  ["requests with sent-back items waiting", "SELECT id FROM requests WHERE reject_mark_at <= 0 AND deleted_at IS NULL ORDER BY reject_mark_at LIMIT 60", "idx_requests_rejected"],
  ["requests with an upload notice due", "SELECT id FROM requests WHERE notice_due_at IS NOT NULL AND (notified_at IS NULL OR notified_at <= 0) AND deleted_at IS NULL ORDER BY notice_due_at LIMIT 60", "idx_requests_notice"],
  ["emails an account sent in 24 hours", "SELECT COUNT(*) FROM messages WHERE firm_id = 'f' AND status IN ('sent', 'sending') AND sent_at > 0", "idx_messages_firm_sent"],
  ["staff invitations in 24 hours", "SELECT COUNT(*) FROM staff_mail WHERE firm_id = 'f' AND sent_at > 0", "idx_staff_mail_firm"],
  ["invitations of one request", "SELECT COUNT(*) FROM messages WHERE firm_id = 'f' AND request_id = 'r' AND kind = 'invite' AND status IN ('sent', 'sending') AND sent_at > 0", "SEARCH messages USING"],
  ["last email to a client", "SELECT sent_at FROM messages WHERE firm_id = 'f' AND client_id = 'c' AND kind IN ('reminder', 'deadline') AND status IN ('sent', 'sending') AND sent_at > 0 ORDER BY sent_at DESC LIMIT 1", "idx_messages_client"],
  ["batches due", "SELECT id FROM batches WHERE status IN ('scheduled', 'sending') AND next_try_at <= 0 ORDER BY next_try_at LIMIT 50", "idx_batches_try"],
  ["people still to invite in a batch", "SELECT request_id FROM batch_items WHERE firm_id = 'f' AND batch_id = 'b' AND state = 'pending' ORDER BY position LIMIT 30", "idx_batch_items_batch"],
  [
    "files to sweep",
    "SELECT rowid FROM files WHERE (state = 'pending' AND uploaded_at < 0) OR (deleted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.firm_id = files.firm_id AND r.id = files.request_id AND r.hold_at IS NOT NULL)) LIMIT 200",
    "idx_files_deleted",
  ],
  ["examples nobody uses", "SELECT rowid FROM examples WHERE created_at < 0 LIMIT 200", "idx_examples_created"],
  ["requests whose link ran out", "SELECT rowid FROM requests WHERE status = 'open' AND ended_at IS NULL AND deleted_at IS NULL AND deadline <= 0 LIMIT 10", "idx_requests_open_deadline"],
  ["requests past their retention", "SELECT id FROM requests WHERE keep_until <= 0 AND hold_at IS NULL AND ended_at IS NOT NULL ORDER BY keep_until LIMIT 10", "idx_requests_keep"],
  ["requests deleted past the restore window", "SELECT id FROM requests WHERE deleted_at <= 0 AND hold_at IS NULL ORDER BY deleted_at LIMIT 10", "idx_requests_deleted"],
  ["clients deleted past the restore window", "SELECT id FROM clients WHERE deleted_at <= 0 ORDER BY deleted_at LIMIT 10", "idx_clients_deleted"],
];

async function plan(db: D1Database, sql: string) {
  const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
  return results.map((r) => r.detail).join("\n");
}

describe("the timed run's queries use an index", () => {
  for (const [name, sql, index] of control) {
    it(`control: ${name}`, async () => {
      expect(await plan(env.CONTROL, sql)).toContain(index);
    });
  }
  for (const [name, sql, index] of na) {
    it(`na: ${name}`, async () => {
      expect(await plan(env.DB_NA, sql)).toContain(index);
    });
  }
});
