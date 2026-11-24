export type Lang = "en" | "fr-CA";

export const isLang = (v: unknown): v is Lang => v === "en" || v === "fr-CA";

// French of any region reads as fr-CA; the first language the header lists that we have wins
export function fromAcceptLanguage(header: string | null | undefined): Lang {
  for (const part of (header ?? "").split(",")) {
    const lang = part.split(";")[0].trim().toLowerCase().split("-")[0];
    if (lang === "fr") return "fr-CA";
    if (lang === "en") return "en";
  }
  return "en";
}

// the tag for Intl: Canadian English, not the US default
export const intlTag = (lang: Lang) => (lang === "en" ? "en-CA" : lang);

// a page opened from an email names its language in the link; without one the browser decides
export const pageLang = (query: string | undefined, header: string | null | undefined): Lang => (isLang(query) ? query : fromAcceptLanguage(header));

// a stored locale read back; anything unknown is English
export const asLang = (v: string | null | undefined): Lang => (isLang(v) ? v : "en");

// The web app sends the language the person picked in X-Lang; a plain request falls back to the browser's.
export const langOf = (c: { req: { header(name: string): string | undefined } }): Lang => {
  const picked = c.req.header("X-Lang");
  return isLang(picked) ? picked : fromAcceptLanguage(c.req.header("Accept-Language"));
};
