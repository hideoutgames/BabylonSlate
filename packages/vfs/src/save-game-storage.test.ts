import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Directory } from "@capacitor/filesystem";
import { createMemoryOpfsRoot } from "./test-support/memory-opfs";
import { WebSaveGameStorage } from "./save-game-web";
import { MobileSaveGameStorage, type SaveGameFilesystem } from "./save-game-mobile";
import { ElectronSaveGameStorage } from "./save-game-electron";
import type { ElectronSaveGameBridge } from "./platform";
import { encodeSaveGameSegment } from "./save-game-path";

const key = "save-games/project/game/player/default/generation-a.save";

function lockManager() {
  const tails = new Map<string, Promise<unknown>>();
  return { request: async <T>(name: string, _options: unknown, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(name) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    tails.set(name, next);
    return next;
  } };
}

async function opfsFile(root: FileSystemDirectoryHandle, logical: string) {
  let directory = await root.getDirectoryHandle("babylonslate-game-saves");
  const parts = logical.split("/");
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(encodeSaveGameSegment(part));
  return directory.getFileHandle(encodeSaveGameSegment(parts.at(-1)!));
}

beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("private OPFS saved games", () => {
  it("reopens separate profiles, preview data, Unicode and case-distinct slots", async () => {
    const root = createMemoryOpfsRoot();
    const first = new WebSaveGameStorage(async () => root);
    await first.write(key, "default");
    await first.write(key.replace("/default/", "/Default/"), "capital");
    await first.write(key.replace("/game/", "/preview/"), "editor");
    await first.write(key.replace("/player/", "/プレイヤー/"), "unicode");
    const reopened = new WebSaveGameStorage(async () => root);
    expect(await reopened.read(key)).toBe("default");
    expect(await reopened.read(key.replace("/default/", "/Default/"))).toBe("capital");
    expect(await reopened.read(key.replace("/game/", "/preview/"))).toBe("editor");
    expect(await reopened.read(key.replace("/player/", "/プレイヤー/"))).toBe("unicode");
    expect(await reopened.list("save-games/project/game/player")).toEqual([
      "save-games/project/game/player/Default/generation-a.save", key,
    ]);
    await reopened.remove(key);
    expect(await reopened.read(key)).toBeNull();
    expect(await reopened.read(key.replace("/default/", "/Default/"))).toBe("capital");
  });

  it("aborts interrupted and quota-failed writes without replacing committed bytes", async () => {
    const root = createMemoryOpfsRoot();
    const storage = new WebSaveGameStorage(async () => root);
    await storage.write(key, "committed");
    const file = await opfsFile(root, key);
    const createWritable = file.createWritable.bind(file);
    vi.spyOn(file, "createWritable").mockImplementation(async () => {
      const writer = await createWritable();
      writer.close = async () => { throw new DOMException("disk full", "QuotaExceededError"); };
      return writer;
    });
    await expect(storage.write(key, "partial replacement")).rejects.toHaveProperty("name", "QuotaExceededError");
    expect(await storage.read(key)).toBe("committed");
  });

  it("distinguishes missing files from unavailable storage and rejects traversal", async () => {
    const root = createMemoryOpfsRoot();
    const storage = new WebSaveGameStorage(async () => root);
    expect(await storage.read(key)).toBeNull();
    expect(await storage.list("save-games/project")).toEqual([]);
    const unavailable = new WebSaveGameStorage(async () => { throw new DOMException("denied", "SecurityError"); });
    await expect(unavailable.read(key)).rejects.toHaveProperty("name", "SecurityError");
    await expect(unavailable.list("save-games/project")).rejects.toHaveProperty("name", "SecurityError");
    await expect(storage.write("../escape", "data")).rejects.toThrow();
    await expect(storage.write("/absolute", "data")).rejects.toThrow();
  });

  it("holds the origin-wide lock across read, update and commit from separate instances", async () => {
    const root = createMemoryOpfsRoot();
    vi.stubGlobal("navigator", { locks: lockManager() });
    const first = new WebSaveGameStorage(async () => root);
    const second = new WebSaveGameStorage(async () => root);
    await first.write(key, "0");
    await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const storage = index % 2 ? first : second;
      return storage.withLock("save-games/project/game", async () => {
        const current = Number(await storage.read(key));
        await Promise.resolve();
        await storage.write(key, String(current + 1));
      });
    }));
    expect(await first.read(key)).toBe("20");
    vi.stubGlobal("navigator", {});
    await expect(first.withLock("save-games/project/game", async () => "unsafe")).rejects.toThrow("locking");
  });

  it("reports the browser persistence decision without claiming permanent storage", async () => {
    vi.stubGlobal("navigator", { storage: { persist: async () => false } });
    expect(await new WebSaveGameStorage().requestPersistence()).toBe(false);
  });
});

function mobileFilesystem() {
  const files = new Map<string, string>();
  const missing = () => Object.assign(new Error("missing"), { code: "OS-PLUG-FILE-0008" });
  const address = (directory: Directory, path: string) => `${directory}/${path}`;
  let failRename: unknown;
  const fs: SaveGameFilesystem = {
    readFile: async ({ path, directory }) => {
      const data = files.get(address(directory, path));
      if (data === undefined) throw missing();
      return { data };
    },
    writeFile: async ({ path, directory, data }) => { files.set(address(directory, path), data); },
    rename: async ({ from, to, directory, toDirectory }) => {
      if (failRename) { files.delete(address(toDirectory, to)); throw failRename; }
      const source = address(directory, from);
      const data = files.get(source);
      if (data === undefined) throw missing();
      files.set(address(toDirectory, to), data);
      files.delete(source);
    },
    deleteFile: async ({ path, directory }) => { if (!files.delete(address(directory, path))) throw missing(); },
    readdir: async ({ path, directory }) => {
      const prefix = `${address(directory, path)}/`;
      const names = new Map<string, string>();
      for (const name of files.keys()) {
        if (!name.startsWith(prefix)) continue;
        const relative = name.slice(prefix.length).split("/");
        names.set(relative[0]!, relative.length > 1 ? "directory" : "file");
      }
      if (!names.size) throw missing();
      return { files: [...names].map(([name, type]) => ({ name, type })) };
    },
  };
  return { fs, files, fail(error: unknown) { failRename = error; } };
}

describe("private native saved games", () => {
  it("uses iOS Library and Android Data independently from Files-visible projects", async () => {
    const harness = mobileFilesystem();
    const ios = new MobileSaveGameStorage(harness.fs, Directory.Library);
    const android = new MobileSaveGameStorage(harness.fs, Directory.Data);
    await ios.write(key, "ios data");
    await android.write(key, "android data");
    expect(await new MobileSaveGameStorage(harness.fs, Directory.Library).read(key)).toBe("ios data");
    expect(await android.read(key)).toBe("android data");
    expect([...harness.files.keys()].some(path => path.startsWith("LIBRARY/Application Support/"))).toBe(true);
    expect([...harness.files.keys()].some(path => path.startsWith("DOCUMENTS/"))).toBe(false);
    expect(await ios.list("save-games/project")).toEqual([key]);
  });

  it("keeps the other generation on interrupted native replacement and maps explicit disk-full errors", async () => {
    const harness = mobileFilesystem();
    const storage = new MobileSaveGameStorage(harness.fs, Directory.Library);
    await storage.write(key, "old generation");
    const inactive = key.replace("generation-a", "generation-b");
    await storage.write(inactive, "previous generation");
    harness.fail(Object.assign(new Error("No space left on device"), { code: "ENOSPC" }));
    await expect(storage.write(inactive, "replacement")).rejects.toHaveProperty("name", "StorageFullError");
    expect(await storage.read(key)).toBe("old generation");
    expect(await storage.list("save-games/project")).toEqual([key]);
    await expect(storage.remove("../escape")).rejects.toThrow();
  });

  it("preserves structured native failures across the Electron bridge", async () => {
    const bridge = { read: async () => ({ ok: false, error: { name: "Error", message: "not readable", code: "EACCES" } }),
      write: async () => ({ ok: false, error: { name: "Error", message: "full", code: "ENOSPC" } }),
    } as ElectronSaveGameBridge;
    const storage = new ElectronSaveGameStorage(bridge);
    await expect(storage.read(key)).rejects.toHaveProperty("code", "EACCES");
    await expect(storage.write(key, "data")).rejects.toHaveProperty("name", "StorageFullError");
  });
});
