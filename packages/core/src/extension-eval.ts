import {
  linkExtensionBundle,
  linkExtensionGameLibraries,
  type ExtensionGameLibrary,
  type ExtensionLibraries,
  type ExtensionModuleBundle,
  type ExtensionModuleCompiler,
  type ExtensionModuleScope,
} from "./extension-library";

/**
 * Compiles an extension module from its CommonJS source with `new Function`: editor code and Editor Play only. Exported
 * games take each module from their static scripts module instead and never evaluate source text.
 */
export function functionExtensionCompiler(label: string): ExtensionModuleCompiler {
  return (module, scopeNames) => new Function("exports", "module", "require", ...scopeNames,
    `${module.code}\n//# sourceURL=haptic-extension:///${encodeURIComponent(label)}/${module.path}`) as (...args: unknown[]) => void;
}

/** Evaluates a linked bundle from its source (`linkExtensionBundle` with `functionExtensionCompiler`). */
export function evaluateExtensionBundle(
  bundle: ExtensionModuleBundle,
  label: string,
  scope: ExtensionModuleScope = {},
  hostModules: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return linkExtensionBundle(bundle, functionExtensionCompiler(label), scope, hostModules);
}

/** Loads game libraries from their source (`linkExtensionGameLibraries` with `functionExtensionCompiler`). */
export function loadExtensionGameLibraries(
  libraries: readonly ExtensionGameLibrary[],
  onError?: (error: Error) => void,
): ExtensionLibraries {
  return linkExtensionGameLibraries(libraries, (library) => functionExtensionCompiler(library.label), onError);
}
