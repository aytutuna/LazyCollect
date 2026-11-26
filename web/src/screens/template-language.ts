import { isLocale, locale, type Locale } from "../i18n";

// the language a request will be written in: the account's, or the client's when the account writes to each client in their own
export function requestLanguage(firm: { locale: string; client_langs: number }, client?: { locale?: string }): Locale {
  const pick = firm.client_langs && client ? client.locale : firm.locale;
  return isLocale(pick) ? pick : locale();
}

// What a built-in checklist already on the page does when the request's language changes: the items follow only if nobody
// has touched them, and the title only if it is still the one the template gave.
export function followLanguage(builtin: { name: string } | undefined, itemsEdited: boolean, title: string, templateTitle: string): { items: boolean; title: string | null } {
  if (!builtin) return { items: false, title: null };
  return { items: !itemsEdited, title: title === templateTitle ? builtin.name : null };
}
