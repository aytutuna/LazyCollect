import { exports } from "cloudflare:workers";
import { vi } from "vitest";
import { DAY } from "../src/util";

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

export const inDays = (n: number) => Date.now() + n * DAY;

export async function setup(email = "owner@firm.test", name: string | null = "Tuna Tax") {
  const cookie = await login(email);
  if (name) await api("/api/firm", { method: "PATCH", cookie, body: { name } });
  const client = await (await api("/api/clients", { method: "POST", cookie, body: { name: "Amy", email: "amy@mail.test", contact_ok: true } })).json<any>();
  return { cookie, client };
}

export async function openRequest(email = "owner@firm.test") {
  const { cookie, client } = await setup(email);
  const req = await (
    await api("/api/requests", {
      method: "POST",
      cookie,
      body: { client_id: client.id, title: "2025 taxes", note: "Hurry", deadline: inDays(7), items: [{ label: "Passport", help: "All pages", required: true }, { label: "Visa", required: false }] },
    })
  ).json<any>();
  const { url } = await (await api(`/api/requests/${req.id}/link`, { method: "POST", cookie })).json<any>();
  return { cookie, req, path: `/api/c/${url.split("/c/")[1]}` };
}

export function randomBytes(n: number, head = ""): Uint8Array {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536) crypto.getRandomValues(out.subarray(at, Math.min(n, at + 65536)));
  out.set(new TextEncoder().encode(head).subarray(0, n));
  return out;
}

export const pdf = (n: number) => randomBytes(n, "%PDF-1.7\n");
export const jpeg = (n: number) => Object.assign(randomBytes(n), [0xff, 0xd8, 0xff, 0xe0]);

export async function sha(b: ArrayBuffer | Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

type Upload = { name?: string; uploadId?: string; ip?: string; headers?: Record<string, string>; omit?: string[] };

export function upload(path: string, itemId: string, body: Uint8Array | ReadableStream, init: Upload = {}) {
  const headers: Record<string, string> = {
    "CF-Connecting-IP": init.ip ?? `192.0.2.${++ipCounter % 250}`,
    "X-Collect": "1",
    "Upload-Id": init.uploadId ?? crypto.randomUUID(),
    "X-File-Name": encodeURIComponent(init.name ?? "doc.pdf"),
    ...(body instanceof Uint8Array ? { "Content-Length": String(body.length) } : {}),
    ...init.headers,
  };
  for (const h of init.omit ?? []) delete headers[h];
  return exports.default.fetch(`https://collect.alazy.app${path}/items/${itemId}/files`, { method: "PUT", headers, body, duplex: "half" } as RequestInit);
}
