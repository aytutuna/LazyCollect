import { afterEach, describe, expect, it, vi } from "vitest";
import { Detector } from "./detector";
import { createEngine } from "./engine";
import { RustEngine } from "./rust-engine";

class FakeWorker {
  onmessage = () => {};
  onerror = () => {};
  postMessage() {}
  terminate() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function open(search: string, storage: unknown) {
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("location", { search });
  vi.stubGlobal("localStorage", storage);
  vi.stubEnv("VITE_RUST_SCANNER", "1");
  return createEngine();
}

describe("choosing the engine", () => {
  const blocked = new Proxy({}, { get: () => () => { throw new DOMException("blocked", "SecurityError"); } });

  it("opens the scanner when site storage is blocked", () => {
    expect(open("", blocked)).toBeInstanceOf(Detector);
    expect(open("?scanner=rust", blocked)).toBeInstanceOf(RustEngine);
  });

  it("remembers ?scanner=rust and forgets it on ?scanner=ts", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    expect(open("?scanner=rust", storage)).toBeInstanceOf(RustEngine);
    expect(open("", storage)).toBeInstanceOf(RustEngine);
    expect(open("?scanner=ts", storage)).toBeInstanceOf(Detector);
    expect(open("", storage)).toBeInstanceOf(Detector);
  });
});
