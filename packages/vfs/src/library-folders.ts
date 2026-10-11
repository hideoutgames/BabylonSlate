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
