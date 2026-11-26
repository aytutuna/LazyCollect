// Single items failing inside a timed step (one email refused, one request that threw) are counted here while the
// timed run is collecting, so a provider outage turns the step red instead of passing as a run of small logs.
// Only a class is kept, never a message, because messages can hold what belongs to a client.
let kinds: string[] | null = null;

export const collect = () => void (kinds = []);

export function itemFailed(kind: string) {
  kinds?.push(kind);
}

export function endCollect(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const k of kinds ?? []) counts[k] = (counts[k] ?? 0) + 1;
  kinds = null;
  return counts;
}

export const classOf = (e: unknown) => (e instanceof Error ? e.name : "error");
