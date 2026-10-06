import type { SaveGameStorage } from "@babylonslate/core";
import { decodeSaveGameSegment, encodeSaveGameSegment, isSaveGameMissing, saveGameSegments } from "./save-game-path";
import { withSaveGameWebLock } from "./save-game-web-lock";

type DirectoryEntries = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

/** OPFS is independent of project folders and never falls back to volatile storage. */
export class WebSaveGameStorage implements SaveGameStorage {
  constructor(private readonly getRoot: () => Promise<FileSystemDirectoryHandle> = async () => {
    if (!globalThis.navigator?.storage?.getDirectory) throw new Error("Save storage requires OPFS");
    return navigator.storage.getDirectory();
  }) {}

  private async directory(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let directory = await (await this.getRoot()).getDirectoryHandle("babylonslate-game-saves", { create });
    for (const part of parts) directory = await directory.getDirectoryHandle(encodeSaveGameSegment(part), { create });
    return directory;
  }

  async read(key: string): Promise<string | null> {
    const parts = saveGameSegments(key);
    try {
      const directory = await this.directory(parts.slice(0, -1), false);
      const handle = await directory.getFileHandle(encodeSaveGameSegment(parts.at(-1)!));
      return new TextDecoder().decode(await (await handle.getFile()).arrayBuffer());
    } catch (error) {
      if (isSaveGameMissing(error)) return null;
      throw error;
    }
  }

  async write(key: string, text: string): Promise<void> {
    const parts = saveGameSegments(key);
    const directory = await this.directory(parts.slice(0, -1), true);
    const handle = await directory.getFileHandle(encodeSaveGameSegment(parts.at(-1)!), { create: true });
    // createWritable stages changes; only close replaces the committed generation.
    const writable = await handle.createWritable();
    try { await writable.write(new TextEncoder().encode(text)); await writable.close(); }
    catch (error) { await writable.abort().catch(() => {}); throw error; }
  }

  async remove(key: string): Promise<void> {
    const parts = saveGameSegments(key);
    try {
      const directory = await this.directory(parts.slice(0, -1), false);
      await directory.removeEntry(encodeSaveGameSegment(parts.at(-1)!));
    } catch (error) { if (!isSaveGameMissing(error)) throw error; }
  }

  async list(prefix: string): Promise<string[]> {
    const parts = saveGameSegments(prefix, true);
    let root: FileSystemDirectoryHandle;
    try { root = await this.directory(parts, false); }
    catch (error) { if (isSaveGameMissing(error)) return []; throw error; }
    const result: string[] = [];
    const walk = async (directory: FileSystemDirectoryHandle, path: string[]): Promise<void> => {
      for await (const [name, handle] of (directory as DirectoryEntries).entries()) {
        const decoded = decodeSaveGameSegment(name);
        if (decoded === null) continue; // Includes uncommitted Chromium swap files.
        const next = [...path, decoded];
        if (handle.kind === "directory") await walk(handle as FileSystemDirectoryHandle, next);
        else result.push(next.join("/"));
      }
    };
    await walk(root, parts);
    return result.sort();
  }

  withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    saveGameSegments(key);
    return withSaveGameWebLock(key, operation);
  }

  async requestPersistence(): Promise<boolean> {
    return await globalThis.navigator?.storage?.persist?.() ?? false;
  }
}
