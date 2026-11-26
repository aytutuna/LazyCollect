export type Lang = "en" | "en-CA" | "fr-CA";

export const isLang = (v: unknown): v is Lang => v === "en" || v === "en-CA" || v === "fr-CA";

// French of any region reads as fr-CA and English from Canada as en-CA; the first language the header lists that we have wins
export function fromAcceptLanguage(header: string | null | undefined): Lang {
  const ranked = (header ?? "")
    .split(",")
    .map((part, at) => {
      const [tag, ...params] = part.split(";");
      const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(p)?.[1]).find(Boolean);
      const [lang, ...rest] = tag.trim().toLowerCase().split("-");
      return { lang, region: rest.at(-1), q: q === undefined ? 1 : Number(q), at };
    })
    .filter((r) => r.q > 0)
    .sort((a, b) => b.q - a.q || a.at - b.at);
  for (const { lang, region } of ranked) {
    if (lang === "fr") return "fr-CA";
    if (lang === "en") return region === "ca" ? "en-CA" : "en";
  }
  return "en";
}

// a long date; French writes the first of the month as 1er, which Intl does not
export function longDate(ms: number, lang: Lang, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(intlTag(lang), { dateStyle: "long", timeZone }).formatToParts(ms);
  return parts.map((p) => (lang === "fr-CA" && p.type === "day" && p.value === "1" ? "1er" : p.value)).join("");
}

export const intlTag = (lang: Lang) => (lang === "en" ? "en-US" : lang);

// a page opened from an email names its language in the link; without one the browser decides
export const pageLang = (query: string | undefined, header: string | null | undefined): Lang => (isLang(query) ? query : fromAcceptLanguage(header));

// a stored locale read back; anything unknown is English
export const asLang = (v: string | null | undefined): Lang => (isLang(v) ? v : "en");

// The web app sends the language the person picked in X-Lang; a plain request falls back to the browser's.
export const langOf = (c: { req: { header(name: string): string | undefined } }): Lang => {
  const picked = c.req.header("X-Lang");
  return isLang(picked) ? picked : fromAcceptLanguage(c.req.header("Accept-Language"));
};

type Writer = { locale: string; client_langs: number };

// A dictionary keyed by language: English from Canada uses the US English words unless the dictionary has a text of its own for it.
export function textsFor<D extends { en: object; "fr-CA": object }>(dict: D, lang: Lang): D["en" | "fr-CA"] {
  return (dict as Partial<Record<Lang, D["en"]>>)[lang] ?? dict.en;
}

// What an account writes to a client in: its own language, or the client's when the account asked for that.
export const writeLang = (firm: Writer, client: { locale: string }): Lang => asLang(firm.client_langs ? client.locale : firm.locale);
