interface Secrets {
  RESEND_API_KEY: string;
  TURNSTILE_SECRET: string;
  HASH_KEY: string;
  RESEND_BASE?: string;
  TURNSTILE_BASE?: string;
}
interface Env extends Secrets {}
declare namespace Cloudflare {
  interface Env extends Secrets {}
}
