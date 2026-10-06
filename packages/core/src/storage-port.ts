export type StorageTier = "documents" | "external" | "opfs";

export interface ProjectFolderHandle {
  id: string;
  name: string;
  tier: StorageTier;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size?: number | null;
  mtime?: number | null;
}

export interface FileStat {
  isDir: boolean;
  size: number | null;
  mtime: number | null;
}

/** Exact bounded read. A revision is opaque and scoped to a project and path. */
export interface StorageRangeRead {
  bytes: Uint8Array;
  totalSize: number;
  revision: string;
  /** Bytes actually returned by the underlying filesystem/transport, before slicing. */
  actualBytesRead: number;
}

/** Retryable snapshot invalidation; malformed files and invalid ranges use other errors. */
export class SourceRevisionChangedError extends Error {
  readonly code = "source-revision-changed";
  constructor(message: string) {
    super(message);
    this.name = "SourceRevisionChangedError";
  }
}

export interface StorageReadMetrics {
  operations: number;
  fullReads: number;
  rangeReads: number;
  requestedBytes: number;
  actualBytesRead: number;
}

/** Read-only view whose path lookup cache may live for one caller operation. */
export type ProjectStorageReader = Pick<ProjectStorage, "readText" | "readBinary" | "readBinaryRange" | "hasStrongSourceRevisions" | "getReadMetrics" | "exists" | "readdir" | "stat">;

/**
 * Binary-capable project filesystem. UI never calls Capacitor directly.
 * @see docs/architecture/vfs.md
 */
export interface ProjectStorage {
  /** Opt-in external folder (picker) or web OPFS project creation. */
  pickProjectFolder(): Promise<ProjectFolderHandle>;
  /** Default iPad / desktop Documents tier — no picker. */
  openDocumentsProject(name: string): Promise<ProjectFolderHandle>;
  /**
   * Rebind a previously known folder (Documents / OPFS / external bookmark)
   * without showing a picker. Picker is only for first bind / Reconnect.
   */
  openKnownFolder(handle: ProjectFolderHandle): Promise<ProjectFolderHandle>;
  /** Enumerate known projects on the default Documents / OPFS tier. */
  listProjects(): Promise<ProjectFolderHandle[]>;
  getCurrentFolder(): ProjectFolderHandle | null;
  /** Release the current folder handle (Close Project). */
  releaseFolder(): Promise<void>;
  /** True when an external bookmark can no longer be resolved. */
  needsReconnect?(): Promise<boolean>;
  /** Validate a picked candidate before replacing a stale external binding. */
  reconnectFolder?(validate?: (candidate: ProjectStorage) => Promise<void>): Promise<ProjectFolderHandle>;
  /**
   * Permanently remove a project folder (web OPFS). Native Documents /
   * chosen-folder adapters omit this — Homepage only drops recents there.
   */
  deleteProject?(handle: ProjectFolderHandle): Promise<void>;

  /** Optional directory-lookup reuse for scans; not a transactional file snapshot. */
  withReadScope?<T>(operation: (storage: ProjectStorageReader) => Promise<T>): Promise<T>;

  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  readBinary(path: string): Promise<Uint8Array>;
  /** Read exactly length bytes; reject invalid bounds or a changed expected revision. Never fall back to a full read. */
  readBinaryRange(path: string, offset: number, length: number, expectedRevision?: string): Promise<StorageRangeRead>;
  /**
   * True only when range revisions cannot alias different file contents (for
   * example immutable catalog hashes or owned in-memory write generations).
   * Filesystem timestamps alone do not establish this, regardless of precision.
   * Readers of mutable catalogs must refresh bounded metadata when omitted/false.
   */
  readonly hasStrongSourceRevisions?: boolean;
  /** Cumulative I/O at this adapter's boundary; counters do not measure retained memory. */
  getReadMetrics?(): StorageReadMetrics;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
}
