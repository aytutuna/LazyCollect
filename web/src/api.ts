import { useEffect, useState } from "preact/hooks";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

const hooks = { unauthorized: () => {}, plan: () => {} };

export function onApiEvents(h: typeof hooks) {
  Object.assign(hooks, h);
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-Collect"] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "network");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401) hooks.unauthorized();
    if (res.status === 402) hooks.plan();
    throw new ApiError(res.status, data?.error ?? "server_error");
  }
  return data as T;
}

export const get = <T>(path: string) => call<T>("GET", path);
export const post = <T = { ok: true }>(path: string, body?: unknown) => call<T>("POST", path, body);
export const patch = <T = { ok: true }>(path: string, body: unknown) => call<T>("PATCH", path, body);
export const del = (path: string) => call<{ ok: true }>("DELETE", path);

export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: true });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ data: s.data, loading: true }));
    load().then(
      (data) => live && setState({ data, loading: false }),
      (error) => live && setState({ error, loading: false }),
    );
    return () => {
      live = false;
    };
  }, [...deps, round]);
  return { ...state, reload: () => setRound((n) => n + 1) };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function run(fn: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}
