interface Secrets {
  RESEND_API_KEY: string;
  TURNSTILE_SECRET: string;
  HASH_KEY: string;
  MASTER_KEY_NA: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_BASE?: string;
  TURNSTILE_BASE?: string;
  STRIPE_API_BASE?: string;
}
interface Env extends Secrets {}
declare namespace Cloudflare {
  interface Env extends Secrets {}
}
