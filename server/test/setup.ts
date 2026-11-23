import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, vi } from "vitest";
import { stripeFake } from "./stripe-fake";

await applyD1Migrations(env.CONTROL, env.TEST_MIGRATIONS);
await applyD1Migrations(env.DB_NA, env.TEST_MIGRATIONS_NA);

beforeEach(async () => {
  vi.restoreAllMocks();
  stripeFake.reset();
  await env.CONTROL.batch(
    ["sessions", "login_codes", "users", "firms", "stripe_events"].map((t) => env.CONTROL.prepare(`DELETE FROM ${t}`)),
  );
  const { objects } = await env.FILES_NA.list();
  await env.FILES_NA.delete(objects.map((o) => o.key));
  await env.DB_NA.batch(
    ["audit", "deletion_log", "firm_settings", "messages", "files", "links", "items", "requests", "templates", "clients"].map((t) => env.DB_NA.prepare(`DELETE FROM ${t}`)),
  );
});
