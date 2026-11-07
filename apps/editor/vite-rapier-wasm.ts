import type { Plugin } from "vite";

/** Rapier 2D's compat glue inside `@dimforge/rapier2d-deterministic-compat`. */
const RAPIER_COMPAT_GLUE = /[\\/]@dimforge[\\/]rapier2d-deterministic-compat[\\/]dist[\\/]rapier\.mjs$/;
/** The glue's `init()` argument: the whole wasm as one base64 literal, decoded in JS. */
const EMBEDDED_WASM = /\b[A-Za-z_$][\w$]*\.toByteArray\("(AGFzbQ[A-Za-z0-9+/]+={0,2})"\)\.buffer/g;
/** The one hosted copy; the name keeps `rapier`, which `selectPlayerRuntimeFiles` filters on. */
export const RAPIER_WASM_FILE = "rapier/rapier_wasm2d.wasm";

/**
 * Rapier 2D's compat package embeds its 2.4 MB wasm as base64 in the glue, so
 * left alone every bundle that imports it (the page and the game worker) ships
 * its own 3.4 MB copy, which compiles only after a JS decode. This plugin emits
 * the decoded wasm once per build as `rapier/rapier_wasm2d.wasm` and hands its
 * URL, resolved from the importing chunk, to the glue's wasm-bindgen `init`,
 * which fetches it and compiles while it downloads when served as
 * `application/wasm` (otherwise it instantiates the downloaded bytes). The
 * binary is the package's own deterministic build, unchanged. A Rapier upgrade
 * that changes the glue fails the build instead of shipping the copies again.
 * Applied to both the page and the worker bundles of the editor and the player;
 * tests and dev keep the package's embedded wasm.
 */
export function rapierHostedWasmVitePlugin(): Plugin {
  return {
    name: "rapier-hosted-wasm",
    apply: "build",
    transform: {
      filter: { id: RAPIER_COMPAT_GLUE },
      handler(code, id) {
        const embedded = [...code.matchAll(EMBEDDED_WASM)];
        const wasm = embedded.length === 1 ? Buffer.from(embedded[0][1], "base64") : null;
        if (!wasm || !isWasmBinary(wasm)) {
          this.error(`Rapier glue ${id} no longer embeds one base64 wasm passed to init; update vite-rapier-wasm.ts.`);
        }
        const reference = this.emitFile({ type: "asset", fileName: RAPIER_WASM_FILE, source: wasm });
        const match = embedded[0];
        const start = match.index;
        return {
          code: `${code.slice(0, start)}import.meta.ROLLUP_FILE_URL_${reference}${code.slice(start + match[0].length)}`,
          map: null,
        };
      },
    },
  };
}

/** `\0asm` followed by version 1. */
function isWasmBinary(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d && bytes[4] === 1;
}
