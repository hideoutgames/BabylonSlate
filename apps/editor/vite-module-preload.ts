import type { Plugin, ResolveModulePreloadDependenciesFn, Rolldown } from "vite";

/**
 * Leaves out of each dynamic import's preload list what the importing chunk has already loaded.
 *
 * Vite wraps a dynamic import that lists dependencies in its preload helper, and every call of the helper queries the
 * whole document for a CSP nonce tag and resolves a URL for each dependency before it finds that it preloaded it
 * already. Babylon imports a node block's shader code again on every NodeMaterial build (`_initShaderSourceAsync`,
 * a few imports per block), and each import listed the chunks the importing chunk itself imports, so every Material
 * build in the editor's large document spent milliseconds in those queries. A chunk's static imports have loaded
 * before any of its code runs, so preloading them does nothing; once they are left out, an import that lists only its
 * own chunk gets no list, as Vite already does when nothing else is listed, and the helper calls `import()` directly.
 * Dependencies the importing chunk has not loaded keep their preload. Entry HTML preloads are unchanged.
 */
export function hostLoadedModulePreload(): { plugin: Plugin; resolveDependencies: ResolveModulePreloadDependenciesFn } {
  let bundle: Rolldown.OutputBundle | null = null;
  const loadedBy = new Map<string, Set<string>>();
  const staticImports = (host: string): Set<string> => {
    let loaded = loadedBy.get(host);
    if (loaded) return loaded;
    loaded = new Set();
    loadedBy.set(host, loaded);
    const pending = [host];
    while (pending.length > 0) {
      const chunk = bundle?.[pending.pop()!];
      if (chunk?.type !== "chunk") continue;
      for (const imported of chunk.imports) {
        if (loaded.has(imported)) continue;
        loaded.add(imported);
        pending.push(imported);
      }
    }
    return loaded;
  };
  return {
    plugin: {
      name: "haptic-host-loaded-module-preload",
      apply: "build",
      // Vite resolves preload lists in its own generateBundle, which runs after this one.
      generateBundle: {
        order: "pre",
        handler(_options, output) {
          bundle = output;
          loadedBy.clear();
        },
      },
    },
    resolveDependencies(filename, deps, { hostId, hostType }) {
      if (hostType !== "js" || !bundle?.[hostId]) return deps;
      const loaded = staticImports(hostId);
      const needed = deps.filter((dep) => !loaded.has(dep));
      return needed.length === 1 && needed[0] === filename ? [] : needed;
    },
  };
}
