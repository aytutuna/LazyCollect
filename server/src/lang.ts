export type Lang = "en" | "fr-CA";

export const isLang = (v: unknown): v is Lang => v === "en" || v === "fr-CA";

// French of any region reads as fr-CA; the first language the header lists that we have wins
export function fromAcceptLanguage(header: string | null | undefined): Lang {
  const ranked = (header ?? "")
    .split(",")
    .map((part, at) => {
      const [tag, ...params] = part.split(";");
      const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(p)?.[1]).find(Boolean);
      return { lang: tag.trim().toLowerCase().split("-")[0], q: q === undefined ? 1 : Number(q), at };
    })
    .filter((r) => r.q > 0)
    .sort((a, b) => b.q - a.q || a.at - b.at);
  for (const { lang } of ranked) {
    if (lang === "fr") return "fr-CA";
    if (lang === "en") return "en";
  }
  return "en";
}

// a long date; French writes the first of the month as 1er, which Intl does not
export function longDate(ms: number, lang: Lang, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(intlTag(lang), { dateStyle: "long", timeZone }).formatToParts(ms);
  return parts.map((p) => (lang === "fr-CA" && p.type === "day" && p.value === "1" ? "1er" : p.value)).join("");
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
