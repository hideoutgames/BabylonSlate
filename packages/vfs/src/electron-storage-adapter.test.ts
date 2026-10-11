import { beforeEach, describe, expect, it, vi } from "vitest";
import { isStorageNotFound, SourceRevisionChangedError } from "@babylonslate/core";
import { ElectronLibraryStorageAdapter, ElectronStorageAdapter } from "./electron-storage-adapter";
import type { ElectronLibraryBridge, ElectronProjectBridge } from "./platform";
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

/** Main-process stand-in: one file tree per library scope. */
function fakeLibraryBridge(): ElectronLibraryBridge & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  const key = (scope: string, path: string) => `${scope}/${path}`;
  return {
    files,
    readBinary: vi.fn(async (scope, path) => {
      const bytes = files.get(key(scope, path));
      if (!bytes) throw new Error(`Error invoking remote method 'library:readBinary': StorageNotFoundError: File not found: ${path}`);
      return bytes.slice().buffer;
    }),
    readBinaryRange: vi.fn(async (scope, path, offset, length) => {
      const bytes = files.get(key(scope, path))!;
      return { bytes: bytes.slice(offset, offset + length).buffer, totalSize: bytes.length, revision: "1", actualBytesRead: length };
    }),
    writeBinary: vi.fn(async (scope, path, data) => { files.set(key(scope, path), new Uint8Array(data)); }),
    exists: vi.fn(async (scope, path) => files.has(key(scope, path))),
    readdir: vi.fn(async () => []),
    mkdir: vi.fn(async () => {}),
    remove: vi.fn(async (scope, path) => { files.delete(key(scope, path)); }),
    stat: vi.fn(async () => ({ isDir: false, size: 0, mtime: 0 })),
  };
}

describe("ElectronLibraryStorageAdapter", () => {
  it("keeps each library's files in its own main-process scope", async () => {
    const bridge = fakeLibraryBridge();
    const templates = new ElectronLibraryStorageAdapter("__slate_templates__", bridge);
    const plugins = new ElectronLibraryStorageAdapter("__slate_engine_plugins__", bridge);
    expect(await templates.openDocumentsProject("__slate_templates__")).toMatchObject({ name: "__slate_templates__" });
    await templates.writeBinary("Starter.zip", new Uint8Array([1, 2, 3]));

    expect([...bridge.files.keys()]).toEqual(["__slate_templates__/Starter.zip"]);
    expect(await templates.readBinary("Starter.zip")).toEqual(new Uint8Array([1, 2, 3]));
    expect((await templates.readBinaryRange("Starter.zip", 1, 2)).bytes).toEqual(new Uint8Array([2, 3]));
    expect(await plugins.exists("Starter.zip")).toBe(false);
    const missing = await plugins.readBinary("Starter.zip").catch((error: unknown) => error);
    expect(isStorageNotFound(missing)).toBe(true);
  });

  it("refuses project folder operations and other folder names", async () => {
    const bridge = fakeLibraryBridge();
    const storage = new ElectronLibraryStorageAdapter("__slate_templates__", bridge);
    await expect(storage.openDocumentsProject("Game")).rejects.toThrow("cannot open or list project folders");
    await expect(storage.pickProjectFolder()).rejects.toThrow("cannot open or list project folders");
    await expect(storage.listProjects()).rejects.toThrow("cannot open or list project folders");
    await expect(storage.openKnownFolder({ id: "node:/elsewhere", name: "Elsewhere", tier: "external" }))
      .rejects.toThrow("cannot open or list project folders");
    expect(storage.getCurrentFolder()).toBeNull();
  });

  it("reports a missing desktop library bridge", async () => {
    const storage = new ElectronLibraryStorageAdapter("__slate_templates__", null);
    await expect(storage.exists("Starter.zip")).rejects.toThrow("bridge is not installed");
  });
});
