import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { embeddedWasm, hostedWasmUrl, isWasmBinary } from "./vite-hosted-wasm";

/** What `@recast-navigation/core`'s `init()` imports when given no implementation: the package's compat build. */
const RECAST_WASM_PACKAGE = /^@recast-navigation\/wasm$/;
/** The package's file build: the same glue, fetching its wasm instead of decoding an embedded copy. */
const RECAST_FILE_BUILD = "@recast-navigation/wasm/wasm";
const RECAST_FILE_GLUE = /[\\/]@recast-navigation[\\/]wasm[\\/]dist[\\/]recast-navigation\.wasm\.js$/;
const RECAST_COMPAT_GLUE = /[\\/]@recast-navigation[\\/]wasm[\\/]dist[\\/]recast-navigation\.wasm-compat\.js$/;
/** The file glue's wasm location when no `locateFile` is supplied, as `init()` supplies none. */
const GLUE_WASM_URL = 'new URL("recast-navigation.wasm.wasm",import.meta.url).href';
/** The compat glue's wasm: one base64 literal, decoded in JS. */
const COMPAT_EMBEDDED_WASM = /\bbase64Decode\("(AGFzbQ[A-Za-z0-9+/]+={0,2})"\)/g;
/** The one hosted copy. Every export keeps it: navigation runs in 2D and 3D games. */
export const RECAST_WASM_FILE = "recast/recast-navigation.wasm";

/**
 * `initNavigation` calls Recast's `init()` without an implementation, which
 * imports the package's compat build: a glue that embeds its 339 KB wasm as
 * base64, so every bundle that loads Recast (the editor page's navigation
 * debug overlay, the game and navmesh bake workers, the player page and game
 * worker) ships its own copy, which compiles only after a JS decode. In builds
 * this plugin resolves that import to the package's file build instead, emits
 * its wasm once per build as `recast/recast-navigation.wasm` and hands the glue
 * that URL, resolved from the importing chunk; the glue fetches it and compiles
 * while it downloads when served as `application/wasm` (otherwise it
 * instantiates the downloaded bytes). The build fails unless the compat build
 * embeds exactly that wasm, so navigation runs the same binary as in tests and
 * dev, which keep the compat build. It also fails if a Recast upgrade changes
 * the file glue's wasm URL or still reaches the compat build. Applied to both
 * the page and the worker bundles of the editor and the player.
 */
export function recastHostedWasmVitePlugin(): Plugin {
  return {
    name: "recast-hosted-wasm",
    apply: "build",
    // Before Vite's resolver, which would otherwise answer the bare package import first.
    enforce: "pre",
    resolveId: {
      filter: { id: RECAST_WASM_PACKAGE },
      handler(_source, importer) {
        return this.resolve(RECAST_FILE_BUILD, importer, { skipSelf: true });
      },
    },
    transform: {
      filter: { id: [RECAST_FILE_GLUE, RECAST_COMPAT_GLUE] },
      handler(code, id) {
        if (RECAST_COMPAT_GLUE.test(id)) {
          this.error(`Recast's compat build ${id} reached the bundle with its base64 wasm; update vite-recast-wasm.ts.`);
        }
        const [before, after, ...extra] = code.split(GLUE_WASM_URL);
        if (after === undefined || extra.length > 0) {
          this.error(`Recast glue ${id} no longer contains one ${GLUE_WASM_URL}; update vite-recast-wasm.ts.`);
        }
        const dist = dirname(id);
        const wasm = readFileSync(join(dist, "recast-navigation.wasm.wasm"));
        const compat = embeddedWasm(readFileSync(join(dist, "recast-navigation.wasm-compat.js"), "utf8"), COMPAT_EMBEDDED_WASM);
        if (!isWasmBinary(wasm) || !compat?.bytes.equals(wasm)) {
          this.error(`Recast's compat build in ${dist} no longer embeds the package's wasm file; update vite-recast-wasm.ts.`);
        }
        return { code: `${before}${hostedWasmUrl(this, RECAST_WASM_FILE, wasm)}${after}`, map: null };
      },
    },
  };
}
