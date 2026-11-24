import { Hono } from "hono";
import { APP_ID } from "./appattest";
import { ANDROID_PACKAGE } from "./playintegrity";
import type { AppEnv } from "./session";

// Files the phone platforms fetch to link the apps to collect.alazy.app, which is what lets passkeys with this
// site's RP ID work in them.
export const wellKnown = new Hono<AppEnv>();

// the signing certificate fingerprints of the Android app, comma separated, with or without colons (apksigner prints
// them without); an entry that is not 32 bytes of hex is dropped
let parsed: { raw: string; certs: string[] } | null = null;

export function androidCerts(env: Env): string[] {
  const raw = env.ANDROID_CERT_SHA256 ?? "";
  // parsed once per isolate, so a bad entry is warned about once and not on every request
  if (parsed?.raw === raw) return parsed.certs;
  const certs: string[] = [];
  for (const entry of raw.split(",")) {
    const hex = entry.replace(/[:\s]/g, "").toUpperCase();
    if (!hex) continue;
    if (/^[0-9A-F]{64}$/.test(hex)) certs.push(hex.match(/../g)!.join(":"));
    else console.warn("ANDROID_CERT_SHA256 has an entry that is not a SHA-256 fingerprint; ignored");
  }
  parsed = { raw, certs };
  return certs;
}

// the origin a passkey ceremony in the Android app reports instead of the site's https origin
export function androidOrigin(fingerprint: string): string {
  const bytes = Uint8Array.from(fingerprint.split(":").map((h) => parseInt(h, 16)));
  return `android:apk-key-hash:${btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

const CACHE = { "Cache-Control": "public, max-age=3600" };

wellKnown.get("/.well-known/assetlinks.json", (c) =>
  c.json(
    [
      {
        relation: ["delegate_permission/common.handle_all_urls", "delegate_permission/common.get_login_creds"],
        target: { namespace: "android_app", package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: androidCerts(c.env) },
      },
    ],
    200,
    CACHE,
  ),
);

// Apple wants this one as JSON with no redirect and no extension
wellKnown.get("/.well-known/apple-app-site-association", (c) =>
  c.json(
    {
      webcredentials: { apps: [APP_ID] },
      applinks: { details: [{ appIDs: [APP_ID], components: [{ "/": "/c/*" }] }] },
    },
    200,
    CACHE,
  ),
);
