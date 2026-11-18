import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, vi } from "vitest";

await applyD1Migrations(env.CONTROL, env.TEST_MIGRATIONS);
await applyD1Migrations(env.DB_NA, env.TEST_MIGRATIONS_NA);

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.CONTROL.batch(
    ["sessions", "login_codes", "users", "firms"].map((t) => env.CONTROL.prepare(`DELETE FROM ${t}`)),
  );
  const { objects } = await env.FILES_NA.list();
  await env.FILES_NA.delete(objects.map((o) => o.key));
  await env.DB_NA.batch(
    ["audit", "files", "links", "items", "requests", "templates", "clients"].map((t) => env.DB_NA.prepare(`DELETE FROM ${t}`)),
  );
});
