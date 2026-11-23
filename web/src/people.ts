import { t } from "./i18n";

type Group<T, P> = { person: P | null; items: T[] };

// the items of a request in the order of its people; what belongs to no one comes first
export function groupByPerson<T extends { person_pos: number | null }, P extends { position: number }>(items: T[], people: P[]): Group<T, P>[] {
  const general = items.filter((i) => i.person_pos === null);
  const groups: Group<T, P>[] = people.map((person) => ({ person, items: items.filter((i) => i.person_pos === person.position) })).filter((g) => g.items.length > 0);
  return general.length > 0 ? [{ person: null, items: general }, ...groups] : groups;
}

export const roleName = (role: string) => t(`people.role.${role}`);
