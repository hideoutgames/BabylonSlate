import { registerPlugin } from "@capacitor/core";

export interface FolderIdentity {
  id: string;
  name: string;
}

export interface BabylonSlateFolderPort {
  pickFolder(): Promise<{ folder: FolderIdentity }>;
  resolveFolder(options: {
    bookmark: string;
  }): Promise<{ folder: FolderIdentity; stale?: boolean }>;
  releaseFolder(): Promise<void>;
  readFile(options: {
    path: string;
    encoding?: "utf8" | "base64";
  }): Promise<{ data: string }>;
  writeFile(options: {
    path: string;
    data: string;
    encoding?: "utf8" | "base64";
  }): Promise<void>;
  exists(options: { path: string }): Promise<{ exists: boolean }>;
  readdir(options: {
    path: string;
  }): Promise<{
    entries: Array<{
      name: string;
      isDir: boolean;
      size: number;
      mtime: number;
    }>;
  }>;
  mkdir(options: { path: string; recursive?: boolean }): Promise<void>;
  deleteFile(options: { path: string }): Promise<void>;
  rmdir(options: { path: string }): Promise<void>;
  stat(options: {
    path: string;
  }): Promise<{ type: string; size: number; mtime: number }>;
}

export const BabylonSlateFolder = registerPlugin<BabylonSlateFolderPort>(
  "BabylonSlateFolder",
);
