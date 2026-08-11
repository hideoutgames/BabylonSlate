export interface ProjectFolderHandle {
  id: string;
  name: string;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size?: number | null;
  mtime?: number | null;
}

export interface ProjectStorage {
  pickProjectFolder(): Promise<ProjectFolderHandle>;
  getCurrentFolder(): ProjectFolderHandle | null;
  readText(path: string): Promise<string>;
  writeText(path: string, data: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  readdir(path: string): Promise<DirEntry[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
}
