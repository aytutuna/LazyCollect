import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, vi } from "vitest";

await applyD1Migrations(env.CONTROL, env.TEST_MIGRATIONS);

beforeEach(async () => {
  vi.restoreAllMocks();
  await env.CONTROL.batch(
    ["sessions", "login_codes", "users", "firms"].map((t) => env.CONTROL.prepare(`DELETE FROM ${t}`)),
  );
});
