import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { SaveGameStorage } from "@babylonslate/core";
import { decodeSaveGameSegment, encodeSaveGameSegment, isSaveGameMissing, normalizeSaveGameStorageError, saveGameSegments } from "./save-game-path";

const locks = new Map<string, Promise<void>>();

/** Main-process storage. The Electron host holds its application single-instance lock. */
export class NodeSaveGameStorage implements SaveGameStorage {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  private path(key: string, allowRoot = false): string {
    return join(this.root, ...saveGameSegments(key, allowRoot).map(encodeSaveGameSegment));
  }

  async read(key: string): Promise<string | null> {
    const path = this.path(key);
    try { return await readFile(path, "utf8"); }
    catch (error) { if (isSaveGameMissing(error)) return null; return normalizeSaveGameStorageError(error); }
  }

  async write(key: string, text: string): Promise<void> {
    const path = this.path(key);
    const temporary = `${path}.pending-${randomUUID()}`;
    try {
      await mkdir(dirname(path), { recursive: true });
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(text, "utf8"); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
      // Persist the directory entry on POSIX. Windows cannot open a directory for fsync.
      if (process.platform !== "win32") {
        const directory = await open(dirname(path), "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      normalizeSaveGameStorageError(error);
    }
  }

  async remove(key: string): Promise<void> {
    const path = this.path(key);
    try { await unlink(path); }
    catch (error) { if (!isSaveGameMissing(error)) normalizeSaveGameStorageError(error); }
  }

  async list(prefix: string): Promise<string[]> {
    const parts = saveGameSegments(prefix, true);
    const result: string[] = [];
    const walk = async (path: string, logical: string[]): Promise<void> => {
      let entries;
      try { entries = await readdir(path, { withFileTypes: true }); }
      catch (error) { if (isSaveGameMissing(error)) return; normalizeSaveGameStorageError(error); }
      for (const entry of entries) {
        const decoded = decodeSaveGameSegment(entry.name);
        if (decoded === null) continue;
        const next = [...logical, decoded];
        if (entry.isDirectory()) await walk(join(path, entry.name), next);
        else if (entry.isFile()) result.push(next.join("/"));
      }
    };
    await walk(this.path(prefix, true), parts);
    return result.sort();
  }

  /** Kept in the main process; renderer locks are released when their window closes. */
  async acquireLock(key: string): Promise<() => void> {
    const name = this.path(key);
    const previous = locks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => held);
    locks.set(name, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      if (locks.get(name) === tail) locks.delete(name);
    };
  }

  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock(key);
    try { return await operation(); } finally { release(); }
  }
}
