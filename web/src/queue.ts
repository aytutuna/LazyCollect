import { ApiError } from "./api";
import { MAX_SIZE, sendFile, type Prepared } from "./upload";

export type Sender = (itemId: string, job: Job, blob: Blob, onProgress: (p: number) => void) => Promise<void>;

export type Job = {
  id: string;
  itemId: string;
  name: string;
  size: number;
  uploadId: string;
  state: "waiting" | "uploading" | "retrying" | "paused" | "failed";
  progress: number;
  error?: unknown;
  // seconds until the next automatic try; 0 while the connection is down
  retryIn?: number;
  // only for a job that could not be stored on the device
  blob?: Blob;
};

type Stored = { id: string; token: string; itemId: string; name: string; size: number; uploadId: string; blob: Blob; at: number };

const DB = "collect-uploads";
const STORE = "jobs";
const KEEP = 14 * 24 * 60 * 60 * 1000;
const MAX_WAIT = 60;
const MAX_AUTO = 6;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" }).createIndex("token", "token");
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function tokenKey(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A failure that waiting can fix: no connection, a busy server, a timeout.
// 409 busy: the first try of this file is still being stored on the server
const transient = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500 || (e.status === 409 && e.code === "busy"));

// Files wait here until the server has confirmed them. They are kept on the device (IndexedDB, under a hash of the link)
// so a reload or an evicted tab picks up where it stopped, and in memory when the browser will not store them.
export class UploadQueue {
  jobs: Job[] = [];
  persistent = true;
  private db: Promise<IDBDatabase | null> = openDb();
  private key: Promise<string>;
  private listeners = new Set<() => void>();
  private timers = new Map<string, number>();
  private attempts = new Map<string, number>();
  private running = false;

  constructor(
    token: string,
    private send: Sender,
    private uploaded: (job: Job) => void,
  ) {
    this.key = tokenKey(token);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit() {
    this.jobs = [...this.jobs];
    this.listeners.forEach((fn) => fn());
  }

  private patch(id: string, change: Partial<Job>) {
    this.jobs = this.jobs.map((j) => (j.id === id ? { ...j, ...change } : j));
    this.listeners.forEach((fn) => fn());
  }

  private async store<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
    const db = await this.db;
    if (!db) return null;
    // a write counts once its transaction has committed; a quota abort rejects here
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      let result: T;
      req.onsuccess = () => {
        result = req.result;
        if (mode === "readonly") resolve(result);
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error ?? req.error);
    });
  }

  // every stored file of this link and everything waiting in memory; returns how many there were
  async forget(): Promise<number> {
    for (const id of this.timers.keys()) this.wake(id);
    let n = this.jobs.length;
    this.jobs = [];
    try {
      const token = await this.key;
      const ids = ((await this.store("readonly", (s) => s.index("token").getAllKeys(token))) ?? []) as string[];
      n = Math.max(n, ids.length);
      for (const id of ids) await this.store("readwrite", (s) => s.delete(id));
    } catch {
      // nothing more can be done with a store that will not open
    }
    this.emit();
    return n;
  }

  async restore() {
    const db = await this.db;
    if (!db) {
      this.persistent = false;
      return this.emit();
    }
    try {
      const token = await this.key;
      const all = (await this.store("readonly", (s) => s.getAll())) as Stored[];
      for (const old of all.filter((r) => Date.now() - r.at > KEEP)) await this.store("readwrite", (s) => s.delete(old.id));
      const mine = all.filter((r) => r.token === token && Date.now() - r.at <= KEEP && !this.jobs.some((j) => j.id === r.id));
      this.jobs = [...this.jobs, ...mine.map(({ blob: _blob, token: _t, at: _a, ...j }): Job => ({ ...j, state: "waiting", progress: 0 }))];
    } catch {
      this.persistent = false;
    }
    this.emit();
    void this.pump();
  }

  async add(itemId: string, files: Prepared[]) {
    const token = await this.key;
    for (const file of files) {
      const job: Job = { id: crypto.randomUUID(), itemId, name: file.name, size: file.blob.size, uploadId: crypto.randomUUID(), state: "waiting", progress: 0 };
      let kept = false;
      if (this.persistent) {
        try {
          const row: Stored = { id: job.id, token, itemId, name: job.name, size: job.size, uploadId: job.uploadId, blob: file.blob, at: Date.now() };
          kept = (await this.store("readwrite", (s) => s.put(row))) !== null;
        } catch {
          // quota or a private window: this file stays in memory
        }
        if (!kept) this.persistent = false;
      }
      this.jobs = [...this.jobs, kept ? job : { ...job, blob: file.blob }];
      this.emit();
    }
    void this.pump();
  }

  retry(id: string) {
    this.attempts.delete(id);
    this.wake(id);
    this.patch(id, { state: "waiting", error: undefined, retryIn: undefined });
    void this.pump();
  }

  async remove(id: string) {
    this.wake(id);
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.emit();
    await this.store("readwrite", (s) => s.delete(id)).catch(() => {});
  }

  // the connection is back: nothing needs to wait out its delay
  online() {
    for (const job of this.jobs) {
      if (job.state === "retrying") {
        this.attempts.delete(job.id);
        this.wake(job.id);
        this.patch(job.id, { state: "waiting", retryIn: undefined });
      }
    }
    void this.pump();
  }

  private wake(id: string) {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }

  private async blobOf(job: Job): Promise<Blob> {
    if (job.blob) return job.blob;
    const row = (await this.store("readonly", (s) => s.get(job.id))) as Stored | undefined | null;
    if (!row) throw new ApiError(410, "missing_file");
    return row.blob;
  }

  // one file at a time keeps a phone's memory and the per-link rate limit comfortable
  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.jobs.find((j) => j.state === "waiting"); job; job = this.jobs.find((j) => j.state === "waiting")) {
        this.patch(job.id, { state: "uploading", progress: 0, error: undefined });
        try {
          const blob = await this.blobOf(job);
          if (blob.size > MAX_SIZE) throw new ApiError(413, "too_big");
          await this.send(job.itemId, job, blob, (progress) => this.patch(job!.id, { progress }));
          this.jobs = this.jobs.filter((j) => j.id !== job!.id);
          this.attempts.delete(job.id);
          this.emit();
          await this.store("readwrite", (s) => s.delete(job!.id)).catch(() => {});
          this.uploaded(job);
        } catch (error) {
          this.failed(job, error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  // the account's plan has ended: the file stays on the device and goes up once the link takes files again
  resume() {
    if (!this.jobs.some((j) => j.state === "paused")) return;
    this.jobs = this.jobs.map((j) => (j.state === "paused" ? { ...j, state: "waiting", error: undefined } : j));
    this.emit();
    void this.pump();
  }

  private failed(job: Job, error: unknown) {
    if (error instanceof ApiError && error.status === 402 && error.code === "paused") return this.patch(job.id, { state: "paused", error });
    if (!transient(error)) return this.patch(job.id, { state: "failed", error });
    const n = (this.attempts.get(job.id) ?? 0) + (navigator.onLine ? 1 : 0);
    this.attempts.set(job.id, n);
    if (!navigator.onLine) return this.patch(job.id, { state: "retrying", error, retryIn: 0 });
    // after about six tries the person decides: the Retry button takes over
    if (n > MAX_AUTO) return this.patch(job.id, { state: "failed", error });
    const wait = Math.min(MAX_WAIT, 2 ** n) + Math.floor(Math.random() * 3);
    this.patch(job.id, { state: "retrying", error, retryIn: wait });
    this.timers.set(
      job.id,
      window.setTimeout(() => {
        this.timers.delete(job.id);
        this.patch(job.id, { state: "waiting", retryIn: undefined });
        void this.pump();
      }, wait * 1000),
    );
  }
}

export function sendJob(token: string): Sender {
  return (itemId, job, blob, onProgress) =>
    sendFile(`/api/c/${encodeURIComponent(token)}/items/${itemId}/files`, { blob, name: job.name, jpeg: false }, job.uploadId, onProgress);
}
