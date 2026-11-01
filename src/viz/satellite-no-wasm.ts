/**
 * Stand-in for satellite.js's optional WebAssembly builds (`#wasm-single-thread`, `#wasm-multi-thread`),
 * aliased in vite.config.ts. src/viz/passes.ts uses only the plain JavaScript SGP4, but satellite.js 7
 * re-exports its WASM runtimes from the main entry; bundling them fails (the multi-thread build starts a
 * Web Worker with top-level await) and would add ~420 KB of unused files. They are only reached through
 * createSingleThreadRuntime()/createMultiThreadRuntime(), which this app never calls.
 */
export default function createWasmModule(): never {
  throw new Error("satellite.js's WebAssembly runtime isn't bundled in this app (see vite.config.ts).");
}
