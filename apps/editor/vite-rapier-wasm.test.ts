import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build, type Plugin } from "vite";
import { selectPlayerRuntimeFiles } from "@haptic/exporter";
import { RAPIER_WASM_FILE, rapierHostedWasmVitePlugin } from "./vite-rapier-wasm";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const RAPIER_DIST = dirname(createRequire(join(REPO_ROOT, "packages/physics/package.json")).resolve("@dimforge/rapier2d-deterministic-compat"));
const RAPIER_GLUE = join(RAPIER_DIST, "rapier.mjs");
/** The package also ships its wasm as a file: the bytes its glue embeds as base64. */
const PACKAGE_WASM_FILE = "rapier_wasm2d_bg.wasm";
const PACKAGE_WASM = readFileSync(join(RAPIER_DIST, PACKAGE_WASM_FILE));
const HOST = "https://game.test/";

type Output = { fileName: string; type: "asset" | "chunk"; source?: string | Uint8Array; code?: string };

/**
 * Bundles a page that imports the real Rapier glue and starts a module worker
 * that imports it too, as the editor and player page and worker bundles do.
 */
async function bundled(base: string, plugins: () => Plugin[]): Promise<Output[]> {
  const entry: Plugin = {
    name: "rapier-entry",
    // The worker's URL reaches the worker build as a path with Vite's worker query.
    resolveId: (id) => /(?:^|\/)virtual:rapier-(?:page|worker)(?:\?|$)/.test(id) ? `\0${id.replace(/^.*?(virtual:rapier-\w+).*$/, "$1")}` : null,
    // An app build keeps only what runs, so each entry starts Rapier as the backend does.
    load: (id) => {
      const init = `import RAPIER from ${JSON.stringify(RAPIER_GLUE)};\nglobalThis.startRapier = () => RAPIER.init();`;
      if (id === "\0virtual:rapier-worker") return init;
      if (id !== "\0virtual:rapier-page") return null;
      return `${init}\nglobalThis.startWorker = () => new Worker(new URL("virtual:rapier-worker", import.meta.url), { type: "module" });`;
    },
  };
  const result = await build({
    configFile: false,
    envFile: false,
    logLevel: "silent",
    root: REPO_ROOT,
    base,
    plugins: [entry, ...plugins()],
    worker: { format: "es", plugins: () => [entry, ...plugins()] },
    build: { write: false, minify: false, rolldownOptions: { input: "virtual:rapier-page" } },
  });
  const bundles = Array.isArray(result) ? result : [result];
  return bundles.flatMap((bundle) => (bundle as { output: Output[] }).output);
}

/** The page chunk and the worker bundle, which Vite emits into the page build as an asset. */
function scripts(files: Output[]): { fileName: string; code: string }[] {
  return files.flatMap((file) => {
    if (file.type === "chunk") return [{ fileName: file.fileName, code: file.code ?? "" }];
    if (!file.fileName.endsWith(".js")) return [];
    return [{ fileName: file.fileName, code: typeof file.source === "string" ? file.source : new TextDecoder().decode(file.source) }];
  });
}

/** Where a script's wasm-bindgen `init` fetches the module from, when served at `HOST`. */
function initUrl(script: { fileName: string; code: string }): string | null {
  const literal = /module_or_path:\s*"([^"]+)"/.exec(script.code)?.[1];
  const relative = /module_or_path:\s*new URL\("([^"]+)",\s*import\.meta\.url\)\.href/.exec(script.code)?.[1];
  const url = literal ?? relative;
  return url ? new URL(url, new URL(script.fileName, HOST)).href : null;
}

const wasmFiles = (files: Output[]) => files.filter((file) => file.fileName.endsWith(".wasm"));

describe("rapierHostedWasmVitePlugin", () => {
  // The editor builds at the site root (or a deployment base), the player relative to its own folder.
  it.each(["/", "./"])("ships Rapier's wasm once per build, unchanged, instead of a base64 copy in every bundle (base %s)", { timeout: 120_000 }, async (base) => {
    // Without the plugin the page and the worker each carry the whole wasm as base64.
    const embedded = await bundled(base, () => []);
    expect(wasmFiles(embedded)).toEqual([]);
    expect(scripts(embedded).filter((script) => script.code.includes("AGFzbQ"))).toHaveLength(2);

    const hosted = await bundled(base, () => [rapierHostedWasmVitePlugin()]);
    const [wasm, ...extra] = wasmFiles(hosted);
    expect(extra).toEqual([]);
    expect(wasm?.fileName).toBe(RAPIER_WASM_FILE);
    expect(Buffer.from(wasm!.source as Uint8Array).equals(PACKAGE_WASM)).toBe(true);
    const bundles = scripts(hosted);
    expect(bundles).toHaveLength(2);
    expect(bundles.some((script) => script.code.includes("AGFzbQ"))).toBe(false);
    // The page and the worker both fetch that one file.
    expect(bundles.map(initUrl)).toEqual([`${HOST}${RAPIER_WASM_FILE}`, `${HOST}${RAPIER_WASM_FILE}`]);
  });

  it("names the hosted wasm so an export keeps it with Rapier and drops it without", () => {
    const files = new Map([[RAPIER_WASM_FILE, new Uint8Array([0, 97, 115, 109])]]);
    expect([...selectPlayerRuntimeFiles(files, { physicsWorld: "2d", platform: "web" }).keys()]).toEqual([RAPIER_WASM_FILE]);
    expect([...selectPlayerRuntimeFiles(files, { physicsWorld: "3d", platform: "web" }).keys()]).toEqual([]);
    expect([...selectPlayerRuntimeFiles(files, { physicsWorld: "3d", platform: "web", hasPhysicsSceneLayers: true }).keys()]).toEqual([RAPIER_WASM_FILE]);
  });

  it("fails the build when the Rapier glue no longer embeds one base64 wasm", () => {
    const plugin = rapierHostedWasmVitePlugin();
    const transform = plugin.transform as {
      handler: (this: { error: (message: string) => never; emitFile: () => string }, code: string, id: string) => unknown;
    };
    const context = { error: (message: string): never => { throw new Error(message); }, emitFile: () => "ref" };
    expect(() => transform.handler.call(context, 'export default init({ module_or_path: "rapier.wasm" });', RAPIER_GLUE))
      .toThrow("no longer embeds one base64 wasm");
    // Base64 that does not decode to a wasm module is a changed glue too.
    expect(() => transform.handler.call(context, 'init({module_or_path:Vg.toByteArray("AGFzbQAAAAAAAAAA").buffer})', RAPIER_GLUE))
      .toThrow("no longer embeds one base64 wasm");
  });
});
