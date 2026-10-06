import type { SaveGameStorage } from "@babylonslate/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { getHostPlatform } from "./platform";
import { decodeSaveGameSegment, encodeSaveGameSegment, isSaveGameMissing, normalizeSaveGameStorageError, saveGameSegments, withSaveGameWebLock } from "./save-game-path";

export interface SaveGameFilesystem {
  readFile(options: { path: string; directory: Directory; encoding: "utf8" }): Promise<{ data: string }>;
  writeFile(options: { path: string; directory: Directory; encoding: "utf8"; data: string; recursive: boolean }): Promise<unknown>;
  rename(options: { from: string; to: string; directory: Directory; toDirectory: Directory }): Promise<void>;
  deleteFile(options: { path: string; directory: Directory }): Promise<void>;
  readdir(options: { path: string; directory: Directory }): Promise<{ files: Array<{ name: string; type: string }> }>;
}

/** Private saved games, independent of the Files-visible mobile project tier. */
export class MobileSaveGameStorage implements SaveGameStorage {
  private readonly root: string;
  constructor(
    private readonly fs: SaveGameFilesystem = Filesystem as unknown as SaveGameFilesystem,
    private readonly directory: Directory = getHostPlatform() === "ios" ? Directory.Library : Directory.Data,
  ) {
    this.root = directory === Directory.Library ? "Application Support/BabylonSlate/game-saves" : "BabylonSlate/game-saves";
  }

  private path(key: string, allowRoot = false): string {
    const encoded = saveGameSegments(key, allowRoot).map(encodeSaveGameSegment);
    return [this.root, ...encoded].join("/");
  }

  async read(key: string): Promise<string | null> {
    const path = this.path(key);
    try { return (await this.fs.readFile({ path, directory: this.directory, encoding: "utf8" })).data; }
    catch (error) { if (isSaveGameMissing(error)) return null; return normalizeSaveGameStorageError(error); }
  }

  async write(key: string, text: string): Promise<void> {
    const path = this.path(key);
    const temporary = `${path}.pending-${crypto.randomUUID()}`;
    try {
      await this.fs.writeFile({ path: temporary, directory: this.directory, encoding: "utf8", data: text, recursive: true });
      // The service chooses the inactive generation. The current valid generation is untouched.
      // Capacitor does not expose fsync: power-loss durability requires native-device validation.
      await this.fs.rename({ from: temporary, to: path, directory: this.directory, toDirectory: this.directory });
    } catch (error) {
      await this.fs.deleteFile({ path: temporary, directory: this.directory }).catch(() => {});
      normalizeSaveGameStorageError(error);
    }
  }

  async remove(key: string): Promise<void> {
    const path = this.path(key);
    try { await this.fs.deleteFile({ path, directory: this.directory }); }
    catch (error) { if (!isSaveGameMissing(error)) normalizeSaveGameStorageError(error); }
  }

  async list(prefix: string): Promise<string[]> {
    const parts = saveGameSegments(prefix, true);
    const result: string[] = [];
    const walk = async (path: string, logical: string[]): Promise<void> => {
      let files: Array<{ name: string; type: string }>;
      try { files = (await this.fs.readdir({ path, directory: this.directory })).files; }
      catch (error) { if (isSaveGameMissing(error)) return; normalizeSaveGameStorageError(error); }
      for (const file of files) {
        const decoded = decodeSaveGameSegment(file.name);
        if (decoded === null) continue;
        const next = [...logical, decoded];
        if (file.type === "directory") await walk(`${path}/${file.name}`, next);
        else if (file.type === "file") result.push(next.join("/"));
      }
    };
    await walk(this.path(prefix, true), parts);
    return result.sort();
  }

  withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    saveGameSegments(key);
    return withSaveGameWebLock(key, operation);
  }
}
