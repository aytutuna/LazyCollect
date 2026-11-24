import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations/control");
  const naMigrations = await readD1Migrations("./migrations/na");
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"])) as CryptoKeyPair;
  const pkcs8 = btoa(String.fromCharCode(...new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer)));
  const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const appleKey = `-----BEGIN PRIVATE KEY-----
${btoa(String.fromCharCode(...new Uint8Array((await crypto.subtle.exportKey("pkcs8", ec.privateKey)) as ArrayBuffer)))}
-----END PRIVATE KEY-----`;
  const privateKey = `-----BEGIN PRIVATE KEY-----
${pkcs8}
-----END PRIVATE KEY-----`;
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
            MASTER_KEY_NA: "dGVzdC1tYXN0ZXIta2V5LTMyLWJ5dGVzLWxvbmchISE=",
            RESEND_BASE: "https://resend.test",
            STRIPE_API_BASE: "https://stripe.test",
            STRIPE_SECRET_KEY: "sk_test_123",
            STRIPE_WEBHOOK_SECRET: "whsec_test",
            STRIPE_PRICE_ID: "price_test",
            TURNSTILE_BASE: "https://turnstile.test",
            PLAY_INTEGRITY_SA: JSON.stringify({ client_email: "checker@play.test", private_key: privateKey, token_uri: "https://oauth.test/token" }),
            PLAY_INTEGRITY_BASE: "https://play.test",
            APPLE_IAP_KEY: appleKey,
            APPLE_IAP_KEY_ID: "KEY1234567",
            APPLE_ISSUER_ID: "issuer-1",
            APPLE_API_BASE: "https://apple.test",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
