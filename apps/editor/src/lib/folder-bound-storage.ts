import type { ProjectStorage } from "@haptic/core";

/** Calls that bind, release or delete folders: a bound view never makes them. */
const BINDING = new Set<PropertyKey>([
  "pickProjectFolder",
  "openDocumentsProject",
  "openKnownFolder",
  "listProjects",
  "releaseFolder",
  "needsReconnect",
  "reconnectFolder",
  "deleteProject",
]);

/**
 * `storage` limited to the project folder `folderId`. Storage adapters bind
 * one folder at a time, and the next project re-points the same adapter, so
 * work that outlives its project (a Git operation finishing after Close
 * Project) would otherwise read and write the next project's files. Every
 * call is refused unless `folderId` is still the bound folder; binding calls
 * are always refused.
 */
export function folderBoundStorage(storage: ProjectStorage, folderId: string): ProjectStorage {
  const bound = () => storage.getCurrentFolder()?.id === folderId;
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(storage, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      let method = methods.get(key);
      if (!method) {
        method = key === "getCurrentFolder"
          ? () => (bound() ? target.getCurrentFolder() : null)
          : key === "getReadMetrics"
            ? value.bind(target)
            : (...args: unknown[]) => {
            if (BINDING.has(key)) return Promise.reject(new Error("A folder-bound storage cannot change its folder."));
            if (!bound()) return Promise.reject(new Error("The project folder is no longer open."));
            return Reflect.apply(value, target, args);
          };
        methods.set(key, method);
      }
      return method;
    },
  });
}
