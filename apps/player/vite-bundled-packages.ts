import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** npm package that owns a bundled module id, from its last `node_modules/` segment. */
export function packageOfModuleId(id: string): string | null {
  const normalized = id.replace(/\\/g, "/").replace(/^\0/, "");
  const at = normalized.lastIndexOf("node_modules/");
  if (at < 0) return null;
  const [first, second] = normalized.slice(at + "node_modules/".length).split("/");
  if (!first || first === ".pnpm") return null;
  return first.startsWith("@") ? (second ? `${first}/${second}` : null) : first;
}

/**
 * Records which npm packages the player bundle and its workers contain, and fails the
 * build when that differs from the game list the third-party notices were generated from
 * (`scripts/third-party-notices/game-packages.json`). Exported games ship notices for
 * exactly these packages.
 */
export function bundledPackagesReport(options: { gamePackagesFile: string }): { main: Plugin; worker: () => Plugin } {
  const found = new Set<string>();
  const collect = (bundle: Record<string, { type: string; moduleIds?: readonly string[] }>) => {
    for (const output of Object.values(bundle)) {
      if (output.type !== "chunk") continue;
      for (const id of output.moduleIds ?? []) {
        const name = packageOfModuleId(id);
        if (name) found.add(name);
      }
    }
  };
  const worker = (): Plugin => ({
    name: "bundled-packages-worker",
    generateBundle(_options, bundle) {
      collect(bundle);
    },
  });
  const main: Plugin = {
    name: "bundled-packages",
    apply: "build",
    buildStart() {
      found.clear();
    },
    generateBundle(_options, bundle) {
      collect(bundle);
    },
    writeBundle(outputOptions) {
      const bundled = [...found].sort();
      const dist = outputOptions.dir ?? "dist";
      writeFileSync(path.join(dist, "bundled-packages.json"), `${JSON.stringify(bundled, null, 2)}\n`);
      const expected = existsSync(options.gamePackagesFile)
        ? (JSON.parse(readFileSync(options.gamePackagesFile, "utf8")) as string[])
        : [];
      if (JSON.stringify(expected) !== JSON.stringify(bundled)) {
        const added = bundled.filter(name => !expected.includes(name));
        const removed = expected.filter(name => !bundled.includes(name));
        throw new Error(
          `The player bundle's npm packages changed (added: ${added.join(", ") || "none"}; removed: ${removed.join(", ") || "none"}). ` +
            "Run pnpm notices --from-player-build and commit the result so exported games ship the right third-party notices.",
        );
      }
    },
  };
  return { main, worker };
}
