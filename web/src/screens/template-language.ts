// What a built-in checklist already on the page does when the request's language changes: the items follow only if nobody
// has touched them, and the title only if it is still the one the template gave.
export function followLanguage(builtin: { name: string } | undefined, itemsEdited: boolean, title: string, templateTitle: string): { items: boolean; title: string | null } {
  if (!builtin) return { items: false, title: null };
  return { items: !itemsEdited, title: title === templateTitle ? builtin.name : null };
}
