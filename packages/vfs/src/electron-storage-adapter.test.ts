import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElectronStorageAdapter } from "./electron-storage-adapter";
import type { ElectronProjectBridge } from "./platform";

function fakeProjectBridge(): ElectronProjectBridge {
  const files = new Map<string, Uint8Array>();
  let folder: { id: string; name: string; tier: "documents" } | null = null;
  return {
    pickProjectFolder: vi.fn(async () => {
      folder = { id: "electron:/tmp/picked", name: "Picked", tier: "documents" };
      return folder;
    }),
    openDocumentsProject: vi.fn(async (name: string) => {
      folder = { id: `electron:/docs/${name}`, name, tier: "documents" };
      return folder;
    }),
    openKnownFolder: vi.fn(async (handle) => {
      folder = { id: handle.id, name: handle.name, tier: "documents" };
      return folder;
    }),
    listProjects: vi.fn(async () => (folder ? [folder] : [])),
    getCurrentFolder: vi.fn(async () => folder),
    releaseFolder: vi.fn(async () => {
      folder = null;
    }),
    readBinary: vi.fn(async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`missing ${path}`);
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    }),
    writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
      files.set(path, new Uint8Array(data));
    }),
    exists: vi.fn(async (path: string) => files.has(path)),
    readdir: vi.fn(async () => []),
    mkdir: vi.fn(async () => {}),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    stat: vi.fn(async () => ({ isDir: false, size: 0, mtime: 0 })),
  };
}

describe("ElectronStorageAdapter", () => {
  beforeEach(() => {
    delete (globalThis as { babylonslate?: unknown }).babylonslate;
  });

  it("round-trips project files through the preload bridge", async () => {
    const bridge = fakeProjectBridge();
    const storage = new ElectronStorageAdapter(bridge);
    const handle = await storage.openDocumentsProject("Game.babproject");
    expect(handle.name).toBe("Game.babproject");
    await storage.writeBinary("assets/a.bin", new Uint8Array([1, 2, 3]));
    expect(await storage.readBinary("assets/a.bin")).toEqual(new Uint8Array([1, 2, 3]));
    expect(await storage.exists("assets/a.bin")).toBe(true);
    await storage.releaseFolder();
    expect(storage.getCurrentFolder()).toBeNull();
  });
});
