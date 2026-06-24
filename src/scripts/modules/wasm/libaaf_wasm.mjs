// Placeholder Emscripten module for LibAAF->WASM.
// Replace this file (and libaaf_wasm.wasm) with your real build output.
//
// Expected exports from the real module:
//   export default function createLibAAF(opts) -> Promise<Module>
// and Module must provide: cwrap, ccall, _malloc, _free, HEAPU8, UTF8ToString
//
// Additionally, the wasm build must export C functions:
//   char* aaf_parse_to_json(uint8_t* data, int size);
//   void  aaf_free(void* p);

export default async function createLibAAF(){
  throw new Error(
    "AAF WASM module not bundled. Build LibAAF with Emscripten and replace scripts/modules/wasm/libaaf_wasm.mjs + libaaf_wasm.wasm."
  );
}
