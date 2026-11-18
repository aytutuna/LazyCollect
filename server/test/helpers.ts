import { exports } from "cloudflare:workers";
import { vi } from "vitest";

export type Sent = { to: string[]; subject: string; text: string; html: string };

export function mockOutbound(turnstileOk = true, resendOk = true) {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://turnstile.test/")) return Response.json({ success: turnstileOk });
    if (url.startsWith("https://resend.test/")) {
      if (!resendOk) return new Response("nope", { status: 500 });
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "email_1" });
    }
    return real(input, init);
  });
  return sent;
}

let ipCounter = 0;

type Init = { method?: string; body?: unknown; cookie?: string; ip?: string; headers?: Record<string, string> };

export function api(path: string, init: Init = {}) {
  const headers: Record<string, string> = {
    "CF-Connecting-IP": init.ip ?? `192.0.2.${++ipCounter % 250}`,
    ...init.headers,
  };
  if (init.method && init.method !== "GET") headers["X-Collect"] ??= "1";
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.cookie) headers.cookie = init.cookie;
  return exports.default.fetch(`https://collect.alazy.app${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: "manual",
  });
}

export function start(email: string) {
  return api("/api/auth/start", { method: "POST", body: { email, turnstile: "tok" } });
}

export function codeFrom(mail: Sent): string {
  return mail.text.match(/code is (\d{6})/)![1];
}

export function linkFrom(mail: Sent): string {
  const url = new URL(mail.text.match(/https:\/\/\S+/)![0]);
  return url.pathname + url.search;
}

export function cookieFrom(res: Response): string {
  return res.headers.get("set-cookie")!.split(";")[0];
}

export async function login(email = "owner@firm.test"): Promise<string> {
  const sent = mockOutbound();
  await start(email);
  const res = await api("/api/auth/verify", { method: "POST", body: { email, code: codeFrom(sent[0]) } });
  return cookieFrom(res);
}
