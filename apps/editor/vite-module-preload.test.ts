import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "vite";
import { hostLoadedModulePreload } from "./vite-module-preload";

// `host` and `other` each import `shared`, so it is a chunk of its own, as Babylon's shared modules are. `host`
// imports `leaf`, which needs only `shared` (loaded with `host`), the way a node block imports its shader code, and
// `fresh`, which also needs `extra`, a chunk that `host` has not loaded.
const FILES: Record<string, string> = {
  // An app build drops the entry's exports, so the entry keeps its imports reachable through a global.
  "main.js": `globalThis.load = { host: () => import("./host.js"), other: () => import("./other.js") };`,
  "shared.js": `export const shared = globalThis.performance ? "shared" : "none";`,
  "extra.js": `export const extra = globalThis.performance ? "extra" : "none";`,
  "host.js": `import { shared } from "./shared.js";
export const leaf = () => import("./leaf.js");
export const fresh = () => import("./fresh.js");
export default shared;`,
  "other.js": `import { shared } from "./shared.js"; import { extra } from "./extra.js"; export default shared + extra;`,
  "leaf.js": `import { shared } from "./shared.js"; export default shared + "leaf";`,
  "fresh.js": `import { shared } from "./shared.js"; import { extra } from "./extra.js"; export default shared + extra + "fresh";`,
};

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "haptic-module-preload-"));
  for (const [name, code] of Object.entries(FILES)) writeFileSync(join(root, name), code);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The built `host` chunk's code, built with or without the plugin. */
async function hostChunk(withPlugin: boolean): Promise<string> {
  const preload = hostLoadedModulePreload();
  const result = await build({
    configFile: false,
    envFile: false,
    logLevel: "silent",
    root,
    plugins: withPlugin ? [preload.plugin] : [],
    build: {
      write: false,
      minify: false,
      modulePreload: withPlugin ? { resolveDependencies: preload.resolveDependencies } : undefined,
      rolldownOptions: { input: join(root, "main.js") },
    },
  });
  const output = (Array.isArray(result) ? result[0] : result) as { output: Array<{ type: string; fileName: string; code?: string }> };
  const host = output.output.find((file) => file.type === "chunk" && /(^|\/)host-[^/]+\.js$/.test(file.fileName));
  if (!host?.code) throw new Error(`No host chunk among ${output.output.map((file) => file.fileName).join(", ")}`);
  return host.code;
}

/** The preload list the host passes for its import of `name`: the dependency file names, or [] for none. */
function preloadList(code: string, name: string): string[] {
  const files = /const __vite__mapDeps=.*?m\.f=(\[[^\]]*\])/.exec(code);
  const table: string[] = files ? JSON.parse(files[1]!) : [];
  const call = new RegExp(`import\\("\\./${name}-[^"]+\\.js"\\)[^,]*,\\s*(\\[\\]|__vite__mapDeps\\(\\[([\\d,]*)\\]\\))`).exec(code);
  if (!call) throw new Error(`No preload call for ${name} in:\n${code}`);
  if (call[1] === "[]") return [];
  // The fixture's names have no dash; a chunk's hash may.
  return call[2]!.split(",").map((index) => table[Number(index)]!.replace(/^.*\//, "").split("-")[0]!);
}

describe("hostLoadedModulePreload", () => {
  it("leaves out what the importing chunk has loaded and keeps what it has not", { timeout: 60_000 }, async () => {
    const before = await hostChunk(false);
    // Without it, the import of `leaf` lists `shared`, which `host` has loaded, so the helper runs on every call.
    expect(preloadList(before, "leaf")).toEqual(["leaf", "shared"]);

    const after = await hostChunk(true);
    expect(preloadList(after, "leaf")).toEqual([]);
    expect(preloadList(after, "fresh").sort()).toEqual(["extra", "fresh"]);
  });
});
