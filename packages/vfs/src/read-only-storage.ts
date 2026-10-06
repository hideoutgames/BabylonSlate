import type { ProjectStorage, ProjectStorageReader } from "@babylonslate/core";

const READ_ONLY_ERROR = "Storage is read-only";

/** Wrap a ProjectStorage so reads work and writes throw. */
export function createReadOnlyProjectStorage(
  inner: ProjectStorage,
): ProjectStorage {
  return {
    get hasStrongSourceRevisions() { return inner.hasStrongSourceRevisions === true; },
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
      ? { reconnectFolder: (validate?: (candidate: ProjectStorage) => Promise<void>) => inner.reconnectFolder!(
          validate ? (candidate) => validate(createReadOnlyProjectStorage(candidate)) : undefined,
        ) }
      : {}),
    ...(inner.deleteProject
      ? {
          deleteProject: async () => {
            throw new Error(READ_ONLY_ERROR);
          },
        }
      : {}),
    readText: (path, options) => inner.readText(path, options),
    readBinary: (path, options) => inner.readBinary(path, options),
    readBinaryRange: (path, offset, length, revision, options) => inner.readBinaryRange(path, offset, length, revision, options),
    ...(inner.getReadMetrics ? { getReadMetrics: () => inner.getReadMetrics!() } : {}),
    ...(inner.withReadScope ? {
      withReadScope: <T>(operation: (storage: ProjectStorageReader) => Promise<T>) => inner.withReadScope!(reader => operation({
        get hasStrongSourceRevisions() { return reader.hasStrongSourceRevisions === true; },
        readText: (path, options) => reader.readText(path, options),
        readBinary: (path, options) => reader.readBinary(path, options),
        readBinaryRange: (path, offset, length, revision, options) => reader.readBinaryRange(path, offset, length, revision, options),
        exists: path => reader.exists(path),
        readdir: path => reader.readdir(path),
        stat: path => reader.stat(path),
        ...(reader.getReadMetrics ? { getReadMetrics: () => reader.getReadMetrics!() } : {}),
      })),
    } : {}),
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
