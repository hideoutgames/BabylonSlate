import { compiledModuleBody, loadExtensionGameLibraries, type CompiledModuleSource, type ExtensionLibraries } from "@haptic/core";
import type { CompiledModuleExports, ScriptModuleLoader } from "./module-loader";

const EMPTY_EXTENSIONS: ExtensionLibraries = Object.freeze(Object.create(null) as ExtensionLibraries);

/**
 * Editor Play's loader: compiles each module's source with `new Function`, so a recompiled graph runs at once. The
 * module shim keeps its functions collectable when source ownership ends; dynamic-import module records remain rooted
 * in the browser realm even after their Blob URL is revoked. Exported games never include it (`createStaticModuleLoader`).
 */
export async function loadCompiledModule(
  module: CompiledModuleSource,
  label: string,
  extensions: ExtensionLibraries = EMPTY_EXTENSIONS,
): Promise<CompiledModuleExports> {
  // `extensions` (gameplay Extension libraries) is the shim's one parameter, a free name for every function in the
  // module, Execute JavaScript bodies included. A final real directive supersedes previous source labels without
  // rewriting authored text that happens to contain a sourceURL-looking template line. The parameter list stays on the
  // wrapper's first line, so COMPILED_MODULE_LINE_OFFSET holds.
  const fn = new Function("extensions", `"use strict";\n${compiledModuleBody(module, label)}\n//# sourceURL=haptic:///${label}.js\n`);
  return fn(extensions) as CompiledModuleExports;
}

export const functionModuleLoader: ScriptModuleLoader = {
  loadScript: (script, label, extensions) => loadCompiledModule(script, label, extensions),
  loadExtensions: async (libraries, onError) => loadExtensionGameLibraries(libraries, onError),
  sourceLocation: () => null,
};
