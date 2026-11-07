/**
 * App-owned user library folders: imported Templates, Engine Plugins and
 * Engine Extensions. The desktop main process accepts exactly these names as
 * storage scopes and binds each to `userData/libraries/<folder>`; the renderer
 * uses the same names on every host. Dependency-free so the Electron main
 * bundle can import it without the renderer's platform code.
 */
export const TEMPLATE_LIBRARY_FOLDER = "__slate_templates__";
export const ENGINE_PLUGIN_LIBRARY_FOLDER = "__slate_engine_plugins__";
export const ENGINE_EXTENSION_LIBRARY_FOLDER = "__slate_engine_extensions__";

export const LIBRARY_FOLDERS = [
  TEMPLATE_LIBRARY_FOLDER,
  ENGINE_PLUGIN_LIBRARY_FOLDER,
  ENGINE_EXTENSION_LIBRARY_FOLDER,
] as const;

export type LibraryFolder = (typeof LIBRARY_FOLDERS)[number];

export function isLibraryFolder(value: unknown): value is LibraryFolder {
  return typeof value === "string" && (LIBRARY_FOLDERS as readonly string[]).includes(value);
}

/** Folder name of the app-private derived-data store; never a project. */
export const DERIVED_STORAGE_ROOT = "__haptic_derived__";

/**
 * An app-owned folder in the default project tier: a user library or the
 * derived-data store. On mobile they sit beside projects, so listing hides
 * them and project deletion refuses them.
 */
export function isAppOwnedFolder(name: string): boolean {
  return isLibraryFolder(name) || name === DERIVED_STORAGE_ROOT;
}
