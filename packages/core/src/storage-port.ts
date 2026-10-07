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

/**
 * The path, or one of its parent directories, does not exist. Permission,
 * I/O, quota, stale-handle and invalid-path failures use other errors, so only
 * this error may be read as "absent".
 */
export class StorageNotFoundError extends Error {
  readonly code = "not-found";
  readonly path: string;
  constructor(path: string, options?: { cause?: unknown; message?: string }) {
    super(options?.message ?? `File not found: ${path}`, options && "cause" in options ? { cause: options.cause } : undefined);
    this.name = "StorageNotFoundError";
    this.path = path;
  }
}

/** True only for a genuine missing path; every other storage failure must propagate. */
export function isStorageNotFound(error: unknown): error is StorageNotFoundError {
  if (error instanceof StorageNotFoundError) return true;
  const candidate = error as { name?: unknown; code?: unknown } | null;
  return typeof candidate === "object" && candidate !== null &&
    candidate.name === "StorageNotFoundError" && candidate.code === "not-found";
}

export interface StorageReadMetrics {
  operations: number;
  fullReads: number;
  rangeReads: number;
  requestedBytes: number;
  actualBytesRead: number;
}

export interface StorageReadOptions {
  /** Abort network transport and body consumption. Non-interruptible local I/O settles before its caller releases reservations. */
  signal?: AbortSignal;
}

/** Read-only view whose path lookup cache may live for one caller operation. */
export type ProjectStorageReader = Pick<ProjectStorage, "readText" | "readBinary" | "readBinaryRange" | "hasStrongSourceRevisions" | "getReadMetrics" | "exists" | "readdir" | "stat">;

/**
 * Binary-capable project filesystem. UI never calls Capacitor directly.
 * Reads, `readdir`, `stat` and `remove` of a missing path reject with
 * `StorageNotFoundError` (message `File not found: <path>`).
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

  readText(path: string, options?: StorageReadOptions): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  readBinary(path: string, options?: StorageReadOptions): Promise<Uint8Array>;
  /** Read exactly length bytes; reject invalid bounds or a changed expected revision. Never fall back to a full read. */
  readBinaryRange(path: string, offset: number, length: number, expectedRevision?: string, options?: StorageReadOptions): Promise<StorageRangeRead>;
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
  /** False only for a missing path; rejects on permission, I/O or invalid-path failures. */
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  /** Rejects with `StorageNotFoundError` when the path is already missing. */
  remove(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
}
