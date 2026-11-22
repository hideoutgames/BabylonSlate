import { linkExtensionGameLibraries, type ExtensionLibraries, type GameScriptsModule } from "@haptic/core";
import type { CompiledModuleExports, ScriptModuleLoader } from "./module-loader";

/**
 * An exported game's loader: every compiled script and Extension library module is a function of the game's static
 * scripts module (`writeGameScriptsModule`), which `load` imports once with a standard module import. Nothing is
 * evaluated from text, so a game runs under a Content Security Policy without `unsafe-eval` and on JIT-less WebKit.
 */
export function createStaticModuleLoader(load: () => Promise<GameScriptsModule>): ScriptModuleLoader {
  let loaded: GameScriptsModule | null = null;
  let loading: Promise<GameScriptsModule> | null = null;
  const registry = () => loading ??= load().then((module) => (loaded = module));
  return {
    async loadScript(_script, label, extensions: ExtensionLibraries): Promise<CompiledModuleExports> {
      const entry = (await registry()).scripts[label];
      if (!entry) throw new Error(`Script ${label} is not in this game's scripts module; rebuild the game.`);
      return entry[1](extensions) as CompiledModuleExports;
    },
    async loadExtensions(libraries, onError) {
      if (libraries.length === 0) return Object.freeze(Object.create(null) as ExtensionLibraries);
      const modules = (await registry()).extensions;
      return linkExtensionGameLibraries(libraries, (library) => (module) => {
        const compiled = modules[library.libraryName]?.[module.path];
        if (!compiled) throw new Error(`Extension module ${module.path} is not in this game's scripts module; rebuild the game.`);
        return compiled;
      }, onError);
    },
    sourceLocation(label) {
      const entry = loaded?.scripts[label];
      return entry && loaded ? { url: loaded.url, firstLine: entry[0] } : null;
    },
  };
}
