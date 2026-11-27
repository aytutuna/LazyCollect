/* tslint:disable */
/* eslint-disable */

/**
 * The corner model, loaded once.
 */
export class Scanner {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The page the model sees in the frame: its eight corner coordinates as shares of the frame, then the confidence;
     * empty when the model has no page. The caller's sanity checks come after.
     */
    detect(rgba: Uint8Array | number[], width: number, height: number): Float64Array;
    /**
     * `onnx` is the model with tract's Einsum fix (tools/patch_einsum.py in LazyKit).
     */
    constructor(onnx: Uint8Array | number[]);
}

/**
 * The page cleaned up as `mode` says: enhanced, whiteboard, gray or bw.
 */
export function clean_up(rgba: Uint8Array | number[], width: number, height: number, mode: string): Uint8Array;

/**
 * What is wrong with where the page sits in a frame: cut, small. `confidence` is the model's, when there is one.
 */
export function frame_problems(outline: Float64Array | number[], confidence: number | null | undefined, width: number, height: number): string[];

/**
 * What is wrong with a flattened page: blur, glare, dark.
 */
export function page_problems(rgba: Uint8Array | number[], width: number, height: number): string[];

/**
 * `outline` (eight pixel coordinates) moved onto the page's edges in the photo: the new outline, then 1 when it moved or
 * 0 when it did not, then how well edges back the weakest side.
 */
export function refine_edges(rgba: Uint8Array | number[], width: number, height: number, outline: Float64Array | number[]): Float64Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_scanner_free: (a: number, b: number) => void;
    readonly clean_up: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly frame_problems: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly page_problems: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly refine_edges: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly scanner_detect: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly scanner_new: (a: number, b: number) => [number, number, number];
    readonly __wbindgen_exn_store_command_export: (a: number) => void;
    readonly __externref_table_alloc_command_export: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc_command_export: (a: number, b: number) => number;
    readonly __wbindgen_free_command_export: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc_command_export: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc_command_export: (a: number) => void;
    readonly __externref_drop_slice_command_export: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
