/** One linked extension module: CommonJS JavaScript plus its resolved relative imports. */
export interface ExtensionModule {
  /** Package-relative source path. */
  path: string;
  /** CommonJS JavaScript (the editor transpiles TypeScript before linking). */
  code: string;
  /** Import specifier, as written, to the package-relative path it names, or to a host module (`haptic:extension`). */
  imports: Record<string, string>;
}

/** The host module game code imports for its own extension's data. */
export const EXTENSION_HOST_MODULE = "haptic:extension";

/** Every module an entry reaches, linked in the editor; plain data, so it crosses workers and ships in game.json. */
export interface ExtensionModuleBundle {
  entry: string;
  modules: ExtensionModule[];
}

/** One asset of a gameplay asset type its extension declares, with values resolved when linked. */
export interface ExtensionLibraryAsset {
  guid: string;
  name: string;
  /** The asset type's id in the manifest (`weatherPreset`). */
  type: string;
  values: Readonly<Record<string, string | number | boolean>>;
}

/** What game code reads from `haptic:extension`: its own extension's settings and gameplay assets. */
export interface ExtensionHostModule {
  readonly settings: Readonly<Record<string, string | number | boolean>>;
  readonly assets: {
    /** Every asset, or those of one asset type id. */
    list(type?: string): readonly ExtensionLibraryAsset[];
    get(guid: string): ExtensionLibraryAsset | null;
  };
}

/** The game module of an enabled gameplay (not Editor Only) extension. */
export interface ExtensionGameLibrary {
  extensionGuid: string;
  /** Key under `extensions` in game code. */
  libraryName: string;
  /** Display name, used in errors and source URLs. */
  label: string;
  /** The extension's Project Settings values, resolved against its fields when linked. */
  settings: Readonly<Record<string, string | number | boolean>>;
  /** The project's assets of the extension's gameplay asset types, in path order. */
  assets: readonly ExtensionLibraryAsset[];
  bundle: ExtensionModuleBundle;
}

/** The frozen `haptic:extension` module one library's game code imports. */
export function extensionHostModule(library: Pick<ExtensionGameLibrary, "settings" | "assets">): ExtensionHostModule {
  const assets = library.assets.map((asset) => Object.freeze({ ...asset, values: Object.freeze({ ...asset.values }) }));
  const byGuid = new Map(assets.map((asset) => [asset.guid, asset]));
  return Object.freeze({
    settings: Object.freeze({ ...library.settings }),
    assets: Object.freeze({
      list: (type?: string) => Object.freeze(assets.filter((asset) => type === undefined || asset.type === type)),
      get: (guid: string) => byGuid.get(guid) ?? null,
    }),
  });
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
  hostModules: Readonly<Record<string, unknown>> = {},
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
      const target = module.imports[specifier]!;
      if (target.startsWith("haptic:")) {
        if (!Object.hasOwn(hostModules, target)) {
          throw new Error(`${target} is available in game code only. Editor code reads its settings with api.settings.`);
        }
        return hostModules[target];
      }
      return load(target);
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
      extensions[library.libraryName] = evaluateExtensionBundle(library.bundle, library.label, { extensions },
        { [EXTENSION_HOST_MODULE]: extensionHostModule(library) });
    } catch (cause) {
      const error = new Error(`Extension ${library.label} failed to load: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      if (!onError) throw error;
      onError(error);
    }
  }
  return Object.freeze(extensions);
}
