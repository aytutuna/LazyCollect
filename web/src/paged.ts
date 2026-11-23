import { useEffect, useRef, useState } from "preact/hooks";
import { useLocation, useSearch } from "wouter-preact";
import { ApiError, get } from "./api";

// list state lives in the address bar, so back, forward and a reload bring the same list again
export function useUrlParams() {
  const search = useSearch();
  const [location, go] = useLocation();
  const params = new URLSearchParams(search);
  function set(changes: Record<string, string>, replace = false) {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(changes)) v ? next.set(k, v) : next.delete(k);
    const q = next.toString();
    go(q ? `${location}?${q}` : location, { replace });
  }
  return { params, set };
}

// the box keeps what is typed; the address bar follows once typing pauses
export function useSearchBox(value: string, commit: (v: string) => void) {
  const [typed, setTyped] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setTyped((cur) => (cur.trim() === value ? cur : value)), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    typed,
    (v: string) => {
      setTyped(v);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => commit(v.trim()), 300);
    },
  ] as const;
}

type Page<T> = { rows: T[]; next: number | null };

// first page of a search, then more on request; `extra` is whatever else the first page carries
export function usePaged<T, E extends object = {}>(path: string, query: string) {
  const [first, setFirst] = useState<{ rows: T[]; next: number | null; extra?: E; error?: ApiError; loading: boolean }>({ rows: [], next: null, loading: true });
  const [more, setMore] = useState<{ busy: boolean; error?: ApiError }>({ busy: false });
  const [round, setRound] = useState(0);
  const current = useRef(query);
  current.current = query;

  useEffect(() => {
    let live = true;
    setFirst((s) => ({ ...s, loading: true, error: undefined }));
    setMore({ busy: false });
    get<Page<T> & E>(`${path}?${query}`).then(
      ({ rows, next, ...extra }) => live && setFirst({ rows, next, extra: extra as unknown as E, loading: false }),
      (error) => live && setFirst((s) => ({ ...s, error, loading: false })),
    );
    return () => {
      live = false;
    };
  }, [path, query, round]);

  async function loadMore() {
    const asked = query;
    setMore({ busy: true });
    try {
      const page = await get<Page<T>>(`${path}?${query}&offset=${first.next}`);
      if (current.current !== asked) return;
      setFirst((s) => ({ ...s, rows: [...s.rows, ...page.rows], next: page.next }));
      setMore({ busy: false });
    } catch (error) {
      if (current.current === asked) setMore({ busy: false, error: error as ApiError });
    }
  }

  return { ...first, more, loadMore, reload: () => setRound((n) => n + 1) };
}
