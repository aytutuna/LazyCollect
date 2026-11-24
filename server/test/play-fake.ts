import { vi } from "vitest";
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

// Google's token endpoint and decodeIntegrityToken: a token string maps to the verdict the fake decodes it to
export function playFake(tokens: Record<string, Verdict>, status = 200) {
  const real = globalThis.fetch;
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://oauth.test/token") return Response.json({ access_token: "ya29.test", expires_in: 3600 });
    if (url.startsWith("https://play.test/")) {
      calls.push(url);
      if (status !== 200) return Response.json({ error: { code: status } }, { status });
      const verdict = tokens[JSON.parse(String(init?.body)).integrity_token];
      return verdict ? Response.json({ tokenPayloadExternal: verdict }) : Response.json({ error: { code: 400 } }, { status: 400 });
    }
    return real(input, init);
  });
  return calls;
}
