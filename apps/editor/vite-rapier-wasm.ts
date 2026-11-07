import type { Plugin } from "vite";
import { embeddedWasm, hostedWasmUrl } from "./vite-hosted-wasm";

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
        const wasm = embeddedWasm(code, EMBEDDED_WASM);
        if (!wasm) {
          this.error(`Rapier glue ${id} no longer embeds one base64 wasm passed to init; update vite-rapier-wasm.ts.`);
        }
        const url = hostedWasmUrl(this, RAPIER_WASM_FILE, wasm.bytes);
        return { code: `${code.slice(0, wasm.index)}${url}${code.slice(wasm.index + wasm.length)}`, map: null };
      },
    },
  };
}

