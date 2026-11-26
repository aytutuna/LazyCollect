// Stands in for rust-engine.ts in builds without VITE_RUST_SCANNER, which carry no WebAssembly (see vite.config.ts)
export class RustEngine {
  constructor() {
    throw new Error("this build has no Rust scanner");
  }
}
