import { beforeEach, describe, expect, it, vi } from "vitest";
import { isStorageNotFound, SourceRevisionChangedError } from "@babylonslate/core";
import { ElectronStorageAdapter } from "./electron-storage-adapter";
import type { ElectronProjectBridge } from "./platform";
import { createMountedProjectStorage } from "./mounted-storage";

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
    readBinaryRange: vi.fn(async (path, offset, length) => {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`missing ${path}`);
      return { bytes: bytes.slice(offset, offset + length).buffer, totalSize: bytes.length, revision: "1", actualBytesRead: length };
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

  it("accounts bytes discarded after native revision validation without publishing them", async () => {
    const bridge = fakeProjectBridge();
    vi.mocked(bridge.readBinaryRange).mockResolvedValue({ bytes: new ArrayBuffer(0), totalSize: 0, revision: "",
      actualBytesRead: 12, error: "Source revision changed", errorCode: "source-revision-changed" });
    const storage = new ElectronStorageAdapter(bridge);
    const mounted = createMountedProjectStorage([{ path: "plugin", storage, sourcePath: "" }]);
    await expect(mounted.readBinaryRange("plugin/asset.babasset", 0, 12)).rejects.toBeInstanceOf(SourceRevisionChangedError);
    expect(storage.getReadMetrics()).toMatchObject({ actualBytesRead: 12, rangeReads: 1, fullReads: 0 });
    expect(mounted.getReadMetrics!()).toMatchObject({ actualBytesRead: 12, rangeReads: 1, fullReads: 0 });
  });

  it.each(["File not found", "Source revision changed"])("does not classify an untyped native failure as retryable: %s", async (message) => {
    const bridge = fakeProjectBridge();
    vi.mocked(bridge.readBinaryRange).mockResolvedValue({
      bytes: new ArrayBuffer(0), totalSize: 0, revision: "", actualBytesRead: 0, error: message,
    });
    const storage = new ElectronStorageAdapter(bridge);
    const failure = await storage.readBinaryRange("asset.babasset", 0, 12).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SourceRevisionChangedError);
    expect(failure).toMatchObject({ message });
    expect(storage.getReadMetrics()).toMatchObject({ actualBytesRead: 0, rangeReads: 1 });
  });

  it("restores the main process's not-found type and keeps other invoke failures", async () => {
    const bridge = fakeProjectBridge();
    // Electron's renderer sees only this message for a rejected invoke.
    vi.mocked(bridge.readBinary).mockRejectedValueOnce(new Error(
      "Error invoking remote method 'project:readBinary': StorageNotFoundError: File not found: missing.json"));
    vi.mocked(bridge.stat).mockRejectedValueOnce(new Error(
      "Error invoking remote method 'project:stat': Error: EACCES: permission denied, stat '/p/project.json'"));
    const storage = new ElectronStorageAdapter(bridge);
    const missing = await storage.readBinary("missing.json").catch((error: unknown) => error);
    expect(isStorageNotFound(missing)).toBe(true);
    expect(missing).toMatchObject({ message: "File not found: missing.json" });
    const denied = await storage.stat("project.json").catch((error: unknown) => error);
    expect(isStorageNotFound(denied)).toBe(false);
    expect((denied as Error).message).toMatch(/EACCES/);
  });
});
