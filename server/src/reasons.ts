import type { Lang } from "./lang";

// The codes are what is stored; the client-facing wording lives in the web app's dictionary. These labels are for the plain-text
// places: the email, the zip's checklist and the activity list.
export const REASONS = {
  blurry: "blurry or hard to read",
  cut_off: "cut off or missing part of the page",
  glare: "glare or shadow",
  dark: "too dark",
  wrong_document: "wrong document",
  wrong_period: "wrong year or period",
  expired: "expired",
  wrong_person: "wrong person",
  pages_missing: "pages missing",
  locked_pdf: "password-protected PDF",
  other: "other",
} as const;

const REASONS_FR: Record<keyof typeof REASONS, string> = {
  blurry: "flou ou difficile à lire",
  cut_off: "page coupée ou incomplète",
  glare: "reflet ou ombre",
  dark: "trop sombre",
  wrong_document: "mauvais document",
  wrong_period: "mauvaise année ou période",
  expired: "expiré",
  wrong_person: "mauvaise personne",
  pages_missing: "pages manquantes",
  locked_pdf: "PDF protégé par un mot de passe",
  other: "autre",
};

export type Reason = keyof typeof REASONS;

// a question is sent back for what it says, not for how it looks
const FOR_QUESTION: Reason[] = ["wrong_period", "wrong_person", "other"];

export const reasonsFor = (kind: string) => (kind === "file" ? (Object.keys(REASONS) as Reason[]) : FOR_QUESTION);

// undefined when something is not a reason that applies to this kind of item
export function parseReasons(v: unknown, kind: string): Reason[] | undefined {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > Object.keys(REASONS).length) return undefined;
  const allowed = reasonsFor(kind);
  const list = v.filter((r): r is Reason => allowed.includes(r));
  return list.length === v.length && new Set(list).size === list.length ? list : undefined;
}

// the stored column as a list of words; "other" has no wording of its own, the note says it
export function reasonLabels(stored: string | null, lang: Lang = "en"): string[] {
  if (!stored) return [];
  return (JSON.parse(stored) as Reason[]).filter((r) => r !== "other").map((r) => (lang === "fr-CA" ? REASONS_FR : REASONS)[r]);
}

// the reasons and the note as one line
export const sentBackText = (stored: string | null, note: string | null, lang: Lang = "en") => [...reasonLabels(stored, lang), ...(note ? [note] : [])].join("; ");
