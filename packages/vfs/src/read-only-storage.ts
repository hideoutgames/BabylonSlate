import type { ProjectStorage } from "@babylonslate/core";

const READ_ONLY_ERROR = "Storage is read-only";

/** Wrap a ProjectStorage so reads work and writes throw. */
export function createReadOnlyProjectStorage(
  inner: ProjectStorage,
): ProjectStorage {
  return {
    pickProjectFolder: () => inner.pickProjectFolder(),
    openDocumentsProject: (name) => inner.openDocumentsProject(name),
    openKnownFolder: (handle) => inner.openKnownFolder(handle),
    listProjects: () => inner.listProjects(),
    getCurrentFolder: () => inner.getCurrentFolder(),
    releaseFolder: () => inner.releaseFolder(),
    ...(inner.needsReconnect
      ? { needsReconnect: () => inner.needsReconnect!() }
      : {}),
    ...(inner.reconnectFolder
      ? { reconnectFolder: () => inner.reconnectFolder!() }
      : {}),
    readText: (path) => inner.readText(path),
    readBinary: (path) => inner.readBinary(path),
    exists: (path) => inner.exists(path),
    readdir: (path) => inner.readdir(path),
    stat: (path) => inner.stat(path),
    writeText: async () => {
      throw new Error(READ_ONLY_ERROR);
    },
    writeBinary: async () => {
      throw new Error(READ_ONLY_ERROR);
    },
    mkdir: async () => {
      throw new Error(READ_ONLY_ERROR);
    },
    remove: async () => {
      throw new Error(READ_ONLY_ERROR);
    },
  };
}
