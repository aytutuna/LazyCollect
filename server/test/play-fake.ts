import { ANDROID_PACKAGE } from "../src/playintegrity";

export type Verdict = {
  requestDetails: { requestPackageName: string; requestHash: string; timestampMillis: string };
  appIntegrity: { appRecognitionVerdict: string; packageName: string };
  deviceIntegrity: { deviceRecognitionVerdict: string[] };
};

export function goodVerdict(requestHash: string): Verdict {
  return {
    requestDetails: { requestPackageName: ANDROID_PACKAGE, requestHash, timestampMillis: String(Date.now()) },
    appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: ANDROID_PACKAGE },
    deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
  };
}

// Google's token endpoint and decodeIntegrityToken, answered through mockOutbound: a token string maps to the verdict
// the fake decodes it to
export const playFake = {
  tokens: {} as Record<string, Verdict>,
  status: 200,
  calls: [] as string[],
  reset() {
    this.tokens = {};
    this.status = 200;
    this.calls = [];
  },
  handle(url: string, init?: RequestInit): Response {
    if (url === "https://oauth.test/token") return Response.json({ access_token: "ya29.test", expires_in: 3600 });
    this.calls.push(url);
    if (this.status !== 200) return Response.json({ error: { code: this.status } }, { status: this.status });
    const verdict = this.tokens[JSON.parse(String(init?.body)).integrity_token];
    return verdict ? Response.json({ tokenPayloadExternal: verdict }) : Response.json({ error: { code: 400 } }, { status: 400 });
  },
};
