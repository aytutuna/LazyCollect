interface Secrets {
  RESEND_API_KEY: string;
  TURNSTILE_SECRET: string;
  HASH_KEY: string;
  MASTER_KEY_NA: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_BASE?: string;
  RESEND_WEBHOOK_SECRET?: string;
  TURNSTILE_BASE?: string;
  STRIPE_API_BASE?: string;
  PLAY_INTEGRITY_SA?: string;
  PLAY_INTEGRITY_BASE?: string;
  APP_ATTEST_ENV?: string;
  APP_ATTEST_ROOT?: string;
  APP_ATTEST_OFF?: string;
  ANDROID_CERT_SHA256?: string;
  COMMIT?: string;
}
interface Env extends Secrets {}
declare namespace Cloudflare {
  interface Env extends Secrets {}
}
