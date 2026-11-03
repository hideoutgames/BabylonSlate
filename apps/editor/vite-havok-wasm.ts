import type { Plugin } from "vite";

/** Havok's Emscripten glue module inside `@babylonjs/havok`. */
const HAVOK_GLUE = /[\\/]@babylonjs[\\/]havok[\\/]lib[\\/]esm[\\/]HavokPhysics_es\.js$/;
/** The glue's fallback wasm location, used only when no `locateFile` is supplied. */
const GLUE_WASM_URL = 'new URL("HavokPhysics.wasm",import.meta.url)';

/**
 * Every host loads Havok's wasm from its one copied `havok/HavokPhysics.wasm`:
 * `loadHavokModule` always supplies `locateFile` (and in a browser instantiates
 * the hosted URL itself), so the glue's `new URL(…, import.meta.url)` fallback
 * never runs. Left in, the bundler emits the 2 MB wasm again for each bundle
 * that imports Havok (the page and the game worker). A Havok upgrade that
 * changes the glue fails the build instead of shipping the copies again.
 * Applied to both the page and the worker bundles of the editor and the player.
 */
export function havokHostedWasmVitePlugin(): Plugin {
  return {
    name: "havok-hosted-wasm",
    apply: "build",
    transform: {
      filter: { id: HAVOK_GLUE },
      handler(code, id) {
        if (!code.includes(GLUE_WASM_URL)) {
          this.error(`Havok glue ${id} no longer contains ${GLUE_WASM_URL}; update vite-havok-wasm.ts.`);
        }
        return { code: code.replaceAll(GLUE_WASM_URL, '"HavokPhysics.wasm"'), map: null };
      },
    },
  };
}
