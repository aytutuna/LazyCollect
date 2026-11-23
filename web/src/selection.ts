import { useState } from "preact/hooks";
import { get } from "./api";
import type { ClientRow, RequestRow } from "./types";

// what a list page hands to the send-to-many form
export const carried = { clients: new Map<string, ClientRow>(), requests: new Map<string, RequestRow>() };

export const MAX_SELECT = 1000;

// every row of a search, a page at a time, for "select all matching"
export async function collect<T>(path: string, query: string): Promise<T[]> {
  const out: T[] = [];
  let offset: number | null = 0;
  while (offset !== null && out.length < MAX_SELECT) {
    const page: { rows: T[]; next: number | null } = await get(`${path}?${query}&offset=${offset}`);
    out.push(...page.rows);
    offset = page.next;
  }
  return out.slice(0, MAX_SELECT);
}

export function useSelection<T extends { id: string }>(initial: Map<string, T>) {
  const [map, setMap] = useState(() => new Map(initial));
  return {
    map,
    has: (id: string) => map.has(id),
    toggle(item: T) {
      const next = new Map(map);
      if (!next.delete(item.id)) next.set(item.id, item);
      setMap(next);
    },
    add(items: T[]) {
      const next = new Map(map);
      for (const i of items) next.set(i.id, i);
      setMap(next);
    },
    remove(ids: string[]) {
      const next = new Map(map);
      for (const id of ids) next.delete(id);
      setMap(next);
    },
    clear: () => setMap(new Map()),
  };
}
