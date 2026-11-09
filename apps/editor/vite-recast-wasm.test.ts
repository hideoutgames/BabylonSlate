import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build, type Plugin } from "vite";
import { selectPlayerRuntimeFiles } from "@haptic/exporter";
import { RECAST_WASM_FILE, recastHostedWasmVitePlugin } from "./vite-recast-wasm";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** Recast's entry, as `@haptic/navigation` imports it. */
const RECAST_CORE = createRequire(join(REPO_ROOT, "packages/navigation/package.json")).resolve("@recast-navigation/core");
const RECAST_WASM_DIST = dirname(createRequire(RECAST_CORE).resolve("@recast-navigation/wasm"));
/** The package's own wasm file, which its compat glue embeds as base64. */
const PACKAGE_WASM = readFileSync(join(RECAST_WASM_DIST, "recast-navigation.wasm.wasm"));
const FILE_GLUE = join(RECAST_WASM_DIST, "recast-navigation.wasm.js");
const COMPAT_GLUE = join(RECAST_WASM_DIST, "recast-navigation.wasm-compat.js");
const GLUE_WASM_URL = 'new URL("recast-navigation.wasm.wasm",import.meta.url).href';
const HOST = "https://game.test/";

type Output = { fileName: string; type: "asset" | "chunk"; source?: string | Uint8Array; code?: string };

/**
 * Bundles a page that starts Recast and a module worker that starts it too,
 * as `initNavigation` does in the editor and player page and worker bundles.
 */
async function bundled(base: string, plugins: () => Plugin[]): Promise<Output[]> {
  const entry: Plugin = {
    name: "recast-entry",
    // The worker's URL reaches the worker build as a path with Vite's worker query.
    resolveId: (id) => /(?:^|\/)virtual:recast-(?:page|worker)(?:\?|$)/.test(id) ? `\0${id.replace(/^.*?(virtual:recast-\w+).*$/, "$1")}` : null,
    load: (id) => {
      const init = `import { init } from ${JSON.stringify(RECAST_CORE)};\nglobalThis.startRecast = () => init();`;
      if (id === "\0virtual:recast-worker") return init;
      if (id !== "\0virtual:recast-page") return null;
      return `${init}\nglobalThis.startWorker = () => new Worker(new URL("virtual:recast-worker", import.meta.url), { type: "module" });`;
    },
  };
  const result = await build({
    configFile: false,
    envFile: false,
    logLevel: "silent",
    root: REPO_ROOT,
    base,
    plugins: [entry, ...plugins()],
    worker: {
      format: "es",
      plugins: () => [entry, ...plugins()],
      // As in the app builds, the worker's Recast chunk is a file of its own; here it would match the page's name.
      rolldownOptions: { output: { chunkFileNames: "worker-[name]-[hash].js" } },
    },
    build: { write: false, minify: false, rolldownOptions: { input: "virtual:recast-page" } },
  });
  const bundles = Array.isArray(result) ? result : [result];
  return bundles.flatMap((bundle) => (bundle as { output: Output[] }).output);
}

/** The page's chunks and the worker's, which Vite emits into the page build as assets. */
function scripts(files: Output[]): { fileName: string; code: string }[] {
  return files.flatMap((file) => {
    if (file.type === "chunk") return [{ fileName: file.fileName, code: file.code ?? "" }];
    if (!file.fileName.endsWith(".js")) return [];
    return [{ fileName: file.fileName, code: typeof file.source === "string" ? file.source : new TextDecoder().decode(file.source) }];
  });
}

/** Where a Recast glue chunk fetches its wasm from without `locateFile`, when served at `HOST`. */
function wasmUrl(script: { fileName: string; code: string }): string | null {
  const fallback = /return locateFile\("recast-navigation\.wasm\.wasm"\)[;}\s]*return ([^;]+);/.exec(script.code)?.[1];
  if (!fallback) return null;
  const literal = /^"([^"]+)"$/.exec(fallback)?.[1];
  const relative = /^new URL\("([^"]+)",\s*import\.meta\.url\)\.href$/.exec(fallback)?.[1];
  const url = literal ?? relative;
  return url ? new URL(url, new URL(script.fileName, HOST)).href : fallback;
}

const wasmFiles = (files: Output[]) => files.filter((file) => file.fileName.endsWith(".wasm"));
const embedsWasm = (script: { code: string }) => script.code.includes("AGFzbQ");

type Handler = (this: { error: (message: string) => never; emitFile: () => string }, code: string, id: string) => { code: string } | undefined;
const handler = (recastHostedWasmVitePlugin().transform as { handler: Handler }).handler;
const context = { error: (message: string): never => { throw new Error(message); }, emitFile: () => "ref" };

describe("recastHostedWasmVitePlugin", () => {
  // The editor builds at the site root or a deployment base (Pages), the player relative to its own folder.
  it.each(["/", "/BabylonSlate/", "./"])("ships Recast's wasm once per build, unchanged, instead of a base64 copy in every bundle (base %s)", { timeout: 120_000 }, async (base) => {
    // Without the plugin the page's and the worker's Recast chunks each carry the whole wasm as base64.
    const embedded = await bundled(base, () => []);
    expect(wasmFiles(embedded)).toEqual([]);
    expect(scripts(embedded).filter(embedsWasm)).toHaveLength(2);

    const hosted = await bundled(base, () => [recastHostedWasmVitePlugin()]);
    const [wasm, ...extra] = wasmFiles(hosted);
    expect(extra).toEqual([]);
    expect(wasm?.fileName).toBe(RECAST_WASM_FILE);
    expect(Buffer.from(wasm!.source as Uint8Array).equals(PACKAGE_WASM)).toBe(true);
    expect(scripts(hosted).filter(embedsWasm)).toEqual([]);
    // The page and the worker both fetch that one file, where the build is served.
    const served = new URL(RECAST_WASM_FILE, new URL(base === "./" ? "/" : base, HOST)).href;
    expect(scripts(hosted).map(wasmUrl).filter(Boolean)).toEqual([served, served]);
  });

  it("names the hosted wasm so every export keeps it, 2D or 3D", () => {
    const files = new Map([[RECAST_WASM_FILE, new Uint8Array([0, 97, 115, 109])]]);
    expect([...selectPlayerRuntimeFiles(files, { physicsWorld: "2d", platform: "web" }).keys()]).toEqual([RECAST_WASM_FILE]);
    expect([...selectPlayerRuntimeFiles(files, { physicsWorld: "3d", platform: "web" }).keys()]).toEqual([RECAST_WASM_FILE]);
  });

  it("fails the build when the Recast glue no longer fetches one wasm from beside itself", () => {
    const glue = readFileSync(FILE_GLUE, "utf8");
    expect(() => handler.call(context, glue.replace(GLUE_WASM_URL, '"recast.wasm"'), FILE_GLUE)).toThrow("no longer contains one");
    expect(() => handler.call(context, `${glue}\n${GLUE_WASM_URL};`, FILE_GLUE)).toThrow("no longer contains one");
  });

  it("fails the build when Recast's compat build reaches the bundle", () => {
    expect(() => handler.call(context, readFileSync(COMPAT_GLUE, "utf8"), COMPAT_GLUE)).toThrow("compat build");
  });

  it("fails the build when the compat build embeds a wasm other than the package's file", () => {
    const root = mkdtempSync(join(tmpdir(), "recast-wasm-"));
    try {
      const dist = join(root, "@recast-navigation", "wasm", "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "recast-navigation.wasm.wasm"), PACKAGE_WASM);
      const other = Buffer.from(PACKAGE_WASM);
      other[other.length - 1] ^= 1;
      writeFileSync(join(dist, "recast-navigation.wasm-compat.js"), `function findWasmBinary(){return base64Decode("${other.toString("base64")}")}`);
      const glue = join(dist, "recast-navigation.wasm.js");
      expect(() => handler.call(context, `function findWasmBinary(){return ${GLUE_WASM_URL}}`, glue)).toThrow("no longer embeds the package's wasm file");

      writeFileSync(join(dist, "recast-navigation.wasm-compat.js"), `function findWasmBinary(){return base64Decode("${PACKAGE_WASM.toString("base64")}")}`);
      expect(handler.call(context, `function findWasmBinary(){return ${GLUE_WASM_URL}}`, glue)?.code)
        .toBe("function findWasmBinary(){return import.meta.ROLLUP_FILE_URL_ref}");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
