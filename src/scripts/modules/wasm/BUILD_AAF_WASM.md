# Build LibAAF -> WebAssembly (WASM) for PostFlowX

This folder ships with a placeholder `libaaf_wasm.mjs/.wasm`.
You must replace them with a real Emscripten build that exports:

- `char* aaf_parse_to_json(uint8_t* data, int size);`
- `void  aaf_free(void* p);`

## High-level steps

1. Install Emscripten SDK (emsdk) and activate it in your shell.
2. Clone LibAAF.
3. Add a small C wrapper (for the two exported functions above) that:
   - Loads the AAF from memory (or writes to MEMFS then opens it),
   - Extracts timeline events (rec/src frames, clip name, source file),
   - Serializes to JSON and returns a malloc()'d string.
4. Build with Emscripten using ES module + modularized output:
   - `-s MODULARIZE=1 -s EXPORT_ES6=1`
5. Copy output to:
   - `scripts/modules/wasm/libaaf_wasm.mjs`
   - `scripts/modules/wasm/libaaf_wasm.wasm`

## Notes

- Keep parsing inside `scripts/modules/workers/aaf_worker.js` (Worker) to prevent UI freeze.
- The JSON schema can be minimal: `{ fps, projectName?, events:[...] }`
