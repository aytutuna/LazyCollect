import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { ApiError } from "./api";
import { t } from "./i18n";
import { errorText } from "./ui";

export const passkeysSupported = browserSupportsWebAuthn;

export const createPasskey = (optionsJSON: PublicKeyCredentialCreationOptionsJSON) => startRegistration({ optionsJSON });
export const askPasskey = (optionsJSON: PublicKeyCredentialRequestOptionsJSON) => startAuthentication({ optionsJSON });

// words for what went wrong, whether the server said no or the browser prompt did
export function passkeyFail(e: unknown): string {
  if (e instanceof ApiError) return errorText(e);
  const code = (e as { code?: string })?.code;
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return t("passkey.already");
  const name = e instanceof Error ? e.name : "";
  return name === "NotAllowedError" || name === "AbortError" ? t("passkey.cancelled") : t("passkey.failed");
}
