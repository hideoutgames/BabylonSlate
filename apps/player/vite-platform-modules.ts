import type { Plugin, Rolldown } from "vite";
import { platformModuleCondition } from "../../packages/core/src/platform-directives";

/** The list packaging reads to leave other platforms' modules out (`selectPlayerRuntimeFiles`). */
export const PLATFORM_MODULES_FILE = "platform-modules.json";

/** Platform modules found while building, shared by the page and worker builds of one player build. */
export interface PlatformModules {
  /** Module id → condition. */
  readonly conditions: Map<string, string>;
  /** Output file → condition. */
  readonly files: Map<string, string>;
}

export function createPlatformModules(): PlatformModules {
  return { conditions: new Map(), files: new Map() };
}

/** `WITH_DESKTOP && !WITH_LINUX` → `platform-desktop-and-not-linux`. */
export function platformChunkName(condition: string): string {
  const slug = condition.toLowerCase().replace(/\bwith_/g, "").replace(/&&/g, " and ").replace(/\|\|/g, " or ").replace(/!/g, " not ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `platform-${slug}`;
}

function shortId(id: string): string {
  return id.replace(/\\/g, "/").replace(/^.*\/(packages|apps)\//, "$1/");
}

/** Code-splitting group that puts every platform module of one condition in its own file. */
export function platformModuleGroup(modules: PlatformModules): Rolldown.CodeSplittingGroup {
  return {
    name: (id: string) => {
      const condition = modules.conditions.get(id);
      return condition === undefined ? null : platformChunkName(condition);
    },
    debugName: "platform modules",
    // A platform module's own imports stay where they are: shared code must not move into a file that a platform leaves out.
    includeDependenciesRecursively: false,
  };
}

/** Why packaging could not leave a platform's files out: a file mixing conditions or plain code, or loaded at start. */
export function platformModuleProblems(bundle: Rolldown.OutputBundle, modules: PlatformModules): { problems: string[]; files: Map<string, string> } {
  const problems: string[] = [];
  const files = new Map<string, string>();
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== "chunk") continue;
    const ids = Object.keys(chunk.modules);
    const conditions = new Set(ids.map((id) => modules.conditions.get(id)).filter((condition) => condition !== undefined));
    if (conditions.size === 0) continue;
    // Bundler helpers (virtual "\0" ids) may sit beside the code that uses them; plain code reaching them through this
    // file would import it statically, which the check below rejects.
    const plain = ids.filter((id) => !modules.conditions.has(id) && !id.startsWith("\0"));
    if (conditions.size > 1 || plain.length > 0) {
      problems.push(`${chunk.fileName} mixes platform modules (${[...conditions].join("; ")}) with ${plain.length > 0 ? plain.map(shortId).join(", ") : "each other"}.`);
      continue;
    }
    files.set(chunk.fileName, [...conditions][0]!);
  }
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== "chunk" || files.has(chunk.fileName)) continue;
    for (const imported of chunk.imports) {
      if (files.has(imported)) {
        problems.push(`${chunk.fileName} statically imports ${imported} (${files.get(imported)}); load a platform module with import() behind a platform check.`);
      }
    }
  }
  return { problems, files };
}

/**
 * Finds the player's platform modules (`platformModuleCondition`: engine code marked as a whole file), fails the build
 * on any other use of platform directives and checks that each platform module's file can be left out. The page build
 * (`writeList`) writes {@link PLATFORM_MODULES_FILE} for its own and the worker build's files.
 */
export function platformModules(modules: PlatformModules, options: { writeList: boolean }): Plugin {
  return {
    name: "player-platform-modules",
    // Before TypeScript is transpiled, so the directive comments are still there.
    enforce: "pre",
    transform(code, id) {
      if (id.includes("/node_modules/") || id.includes("\\node_modules\\") || !/\.(?:[cm]?[jt]sx?)(?:\?.*)?$/.test(id)) return null;
      const path = id.replace(/\?.*$/, "");
      try {
        const condition = platformModuleCondition(code, shortId(path));
        if (condition === null) modules.conditions.delete(path);
        else modules.conditions.set(path, condition);
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error));
      }
      return null;
    },
    generateBundle(_options, bundle) {
      const { problems, files } = platformModuleProblems(bundle, modules);
      if (problems.length) this.error(problems.join("\n"));
      for (const [file, condition] of files) modules.files.set(file, condition);
      if (!options.writeList) return;
      const list = Object.fromEntries([...modules.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      this.emitFile({ type: "asset", fileName: PLATFORM_MODULES_FILE, source: `${JSON.stringify(list, null, 2)}\n` });
    },
  };
}
