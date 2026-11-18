declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    TEST_MIGRATIONS_NA: import("cloudflare:test").D1Migration[];
  }
}
