import { bindingHash } from "../src/attest";
import { api } from "./helpers";
import { goodVerdict, playFake } from "./play-fake";

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

export const post = (path: string, body: unknown, headers: Record<string, string> = {}, ip?: string) => api(path, { method: "POST", body, headers, ip });
export const pendingHeader = (token: string) => ({ Authorization: `Pending ${token}` });
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// a challenge and the Play Integrity token an honest app would send with it for request data (data)
export async function proof(data: string, platform = "android") {
  const { challenge } = await (await post("/api/app/challenge", { platform })).json<any>();
  const token = `tok-${challenge}`;
  playFake.tokens[token] = goodVerdict(b64url(await bindingHash(challenge, data)));
  return { challenge, token };
}

// APP_ATTEST_OFF is honoured only with a local APP_URL, whose type is the live address
export const setAppUrl = (env: Env, url: string) => {
  (env as { APP_URL: string }).APP_URL = url;
};
