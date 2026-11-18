import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations/control");
  const naMigrations = await readD1Migrations("./migrations/na");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_MIGRATIONS_NA: naMigrations,
            TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
            RESEND_API_KEY: "re_test",
            HASH_KEY: "test-salt",
            RESEND_BASE: "https://resend.test",
            TURNSTILE_BASE: "https://turnstile.test",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
