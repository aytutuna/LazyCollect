import { Authenticator } from "./authenticator";
import { api, codeFrom, mockOutbound, start } from "./helpers";

export function cookiesOf(res: Response): Record<string, string> {
  return Object.fromEntries(res.headers.getSetCookie().map((c) => [c.split("=")[0], c.split(";")[0]]));
}

export const SESSION = "__Host-lc_session";
export const PENDING = "__Host-lc_pending";

// registers an authenticator for a signed-in user through the settings routes
export async function addPasskey(cookie: string, key: Authenticator, name?: string) {
  const options = await (await api("/api/passkeys/options", { method: "POST", cookie })).json<any>();
  return api("/api/passkeys", { method: "POST", cookie, body: { response: await key.register(options), name } });
}

// email code accepted; returns the answer and the cookies it set
export async function codeStep(email: string, via: "code" | "link" = "code") {
  const sent = mockOutbound();
  await start(email);
  let res: Response;
  if (via === "code") res = await api("/api/auth/verify", { method: "POST", body: { email, code: codeFrom(sent[0]) } });
  else res = await api("/api/auth/link", { method: "POST", body: { t: new URL(sent[0].text.match(/https:\/\/\S+/)![0]).searchParams.get("t") } });
  return { res, body: await res.json<any>(), cookies: cookiesOf(res) };
}

export const pendingOptions = (pending: string, ip?: string) => api("/api/auth/pending/options", { method: "POST", cookie: pending, ip });
export const pendingVerify = (pending: string, response: unknown, extra: object = {}) =>
  api("/api/auth/pending/verify", { method: "POST", cookie: pending, body: { response, ...extra } });

// the whole second step with the given authenticator
export async function secondStep(pending: string, key: Authenticator) {
  const asked = await pendingOptions(pending);
  if (!asked.ok) return { res: asked, cookies: {} };
  const { options } = await asked.json<any>();
  const res = await pendingVerify(pending, await key.assert(options));
  return { res, cookies: cookiesOf(res) };
}
