import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { SaveGameStorage } from "@haptic/core";
import { decodeSaveGameSegment, encodeSaveGameSegment, isSaveGameMissing, normalizeSaveGameStorageError, saveGameSegments } from "./save-game-path";

/** Paths of granted locks, and requests waiting in arrival order. */
const heldLocks: string[] = [];
const waitingLocks: { path: string; grant: () => void }[] = [];

/** A lock covers its key and every key below it. */
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}

/** Grant each waiting request that overlaps no granted or earlier waiting lock. */
function grantWaitingLocks(): void {
  const blocked = [...heldLocks];
  for (let index = 0; index < waitingLocks.length;) {
    const request = waitingLocks[index]!;
    const free = !blocked.some(path => overlaps(path, request.path));
    blocked.push(request.path);
    if (!free) { index += 1; continue; }
    waitingLocks.splice(index, 1);
    heldLocks.push(request.path);
    request.grant();
  }
}

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

  /**
   * Kept in the main process; renderer locks are released when their window
   * closes. A held key also excludes its ancestors and descendants, because a
   * lease grants access to every key below it.
   */
  async acquireLock(key: string): Promise<() => void> {
    const path = this.path(key);
    await new Promise<void>(grant => {
      waitingLocks.push({ path, grant });
      grantWaitingLocks();
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      heldLocks.splice(heldLocks.indexOf(path), 1);
      grantWaitingLocks();
    };
  }

  async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireLock(key);
    try { return await operation(); } finally { release(); }
  }
}
