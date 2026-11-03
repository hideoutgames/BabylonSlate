import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build, type Plugin } from "vite";
import { havokHostedWasmVitePlugin } from "./vite-havok-wasm";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const HAVOK_GLUE = join(
  dirname(createRequire(join(REPO_ROOT, "packages/physics/package.json")).resolve("@babylonjs/havok/lib/esm/HavokPhysics.wasm")),
  "HavokPhysics_es.js",
);

/** Bundles one module that imports the real Havok glue, as the page and worker bundles do. */
async function bundledFiles(plugins: Plugin[]): Promise<string[]> {
  const entry: Plugin = {
    name: "havok-entry",
    resolveId: (id) => (id === "virtual:havok-entry" ? "\0havok-entry" : null),
    load: (id) => (id === "\0havok-entry" ? `export { default } from ${JSON.stringify(HAVOK_GLUE)};` : null),
  };
  const result = await build({
    configFile: false,
    envFile: false,
    logLevel: "silent",
    root: REPO_ROOT,
    plugins: [entry, ...plugins],
    build: { write: false, minify: false, rolldownOptions: { input: "virtual:havok-entry" } },
  });
  const bundles = Array.isArray(result) ? result : [result];
  return bundles.flatMap((bundle) => (bundle as { output: { fileName: string }[] }).output.map((file) => file.fileName));
}

describe("havokHostedWasmVitePlugin", () => {
  it("keeps a bundle importing Havok from emitting its own copy of the wasm", { timeout: 60_000 }, async () => {
    // The glue's fallback URL alone makes the bundler emit the 2 MB wasm.
    expect((await bundledFiles([])).filter((file) => file.endsWith(".wasm"))).toHaveLength(1);
    const files = await bundledFiles([havokHostedWasmVitePlugin()]);
    expect(files.filter((file) => file.endsWith(".wasm"))).toEqual([]);
    expect(files.some((file) => file.endsWith(".js"))).toBe(true);
  });

  it("fails the build when the Havok glue no longer has the fallback it removes", async () => {
    const plugin = havokHostedWasmVitePlugin();
    const transform = plugin.transform as { handler: (this: { error: (message: string) => never }, code: string, id: string) => unknown };
    const context = { error: (message: string): never => { throw new Error(message); } };
    expect(() => transform.handler.call(context, "export default {};", HAVOK_GLUE)).toThrow("no longer contains");
  });
});
