// Ambient types for binary assets bundled via the wrangler.jsonc "rules".
// wrangler's bundler turns these into a WebAssembly.Module / ArrayBuffer at
// build time; TS has no way to know that from the file extension alone.

declare module '*.wasm' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}

declare module '*.ttf' {
  const data: ArrayBuffer;
  export default data;
}
