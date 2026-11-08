/** One linked extension module: CommonJS JavaScript plus its resolved relative imports. */
export interface ExtensionModule {
  /** Package-relative source path. */
  path: string;
  /** CommonJS JavaScript (the editor transpiles TypeScript before linking). */
  code: string;
  /** Import specifier, as written, to the package-relative path it names. */
  imports: Record<string, string>;
}

/** Every module an entry reaches, linked in the editor; plain data, so it crosses workers and ships in game.json. */
export interface ExtensionModuleBundle {
  entry: string;
  modules: ExtensionModule[];
}

/** The game module of an enabled gameplay (not Editor Only) extension. */
export interface ExtensionGameLibrary {
  extensionGuid: string;
  /** Key under `extensions` in game code. */
  libraryName: string;
  /** Display name, used in errors and source URLs. */
  label: string;
  bundle: ExtensionModuleBundle;
}

/** `extensions.<libraryName>` → that library's exports. */
export type ExtensionLibraries = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/** Free names every extension module sees beside `exports`, `module` and `require`. */
export type ExtensionModuleScope = Readonly<Record<string, unknown>>;

/**
 * Evaluates a linked bundle with CommonJS semantics (one instance per module,
 * cycles see partial exports) and returns the entry's exports. Extensions are
 * trusted code, not a sandbox.
 */
export function evaluateExtensionBundle(
  bundle: ExtensionModuleBundle,
  label: string,
  scope: ExtensionModuleScope = {},
): Record<string, unknown> {
  const modules = new Map(bundle.modules.map((module) => [module.path, module]));
  const instances = new Map<string, { exports: Record<string, unknown> }>();
  const names = Object.keys(scope);
  const values = names.map((name) => scope[name]);
  const load = (path: string): Record<string, unknown> => {
    const existing = instances.get(path);
    if (existing) return existing.exports;
    const module = modules.get(path);
    if (!module) throw new Error(`Extension module is missing: ${path}`);
    const instance = { exports: {} as Record<string, unknown> };
    instances.set(path, instance);
    const require = (specifier: unknown) => {
      if (typeof specifier !== "string" || !Object.hasOwn(module.imports, specifier)) {
        throw new Error(`Extension module ${path} cannot import ${String(specifier)}.`);
      }
      return load(module.imports[specifier]!);
    };
    const evaluate = new Function("exports", "module", "require", ...names,
      `${module.code}\n//# sourceURL=haptic-extension:///${encodeURIComponent(label)}/${module.path}`);
    evaluate(instance.exports, instance, require, ...values);
    return instance.exports;
  };
  return load(bundle.entry);
}

/**
 * Evaluates game libraries in the given order (dependencies first). Each module
 * sees the libraries loaded before it as `extensions`; the result is frozen.
 * A library that fails is passed to `onError` and left out (without `onError`
 * it throws), so independent libraries still load.
 */
export function loadExtensionGameLibraries(
  libraries: readonly ExtensionGameLibrary[],
  onError?: (error: Error) => void,
): ExtensionLibraries {
  const extensions = Object.create(null) as Record<string, Readonly<Record<string, unknown>>>;
  for (const library of libraries) {
    try {
      if (Object.hasOwn(extensions, library.libraryName)) {
        throw new Error(`Library Name ${library.libraryName} is already used.`);
      }
      extensions[library.libraryName] = evaluateExtensionBundle(library.bundle, library.label, { extensions });
    } catch (cause) {
      const error = new Error(`Extension ${library.label} failed to load: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      if (!onError) throw error;
      onError(error);
    }
  }
  return Object.freeze(extensions);
}
