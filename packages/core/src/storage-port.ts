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
  /** Re-pick and re-bind a stale external folder. */
  reconnectFolder?(): Promise<ProjectFolderHandle>;
  /**
   * Permanently remove a project folder (web OPFS). Native Documents /
   * chosen-folder adapters omit this — Homepage only drops recents there.
   */
  deleteProject?(handle: ProjectFolderHandle): Promise<void>;

  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  readBinary(path: string): Promise<Uint8Array>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
}
