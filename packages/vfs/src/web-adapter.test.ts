import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createFakeWebLocks } from "./test-support/fake-web-locks";
import { createMemoryOpfsRoot, opfsProjectFolder } from "./test-support/memory-opfs";
import { webcrypto } from "node:crypto";
import { createStorage } from "./create-storage";
import { TEST_PROJECT_NAME } from "./test-mode";
import { OpfsStorageAdapter } from "./web-adapter";
import { isProjectOpenElsewhere, isStorageNotFound, SourceRevisionChangedError } from "@haptic/core";
import { createMountedProjectStorage } from "./mounted-storage";

vi.mock("./test-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./test-mode")>();
  return {
    ...actual,
    isTestModeEnabled: vi.fn(() => false),
  };
});

import { isTestModeEnabled } from "./test-mode";

async function openedAdapter() {
  const storage = new OpfsStorageAdapter();
  await storage.openDocumentsProject("Test.hproject");
  return storage;
}

describe("OPFS / web storage adapter", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    const root = createMemoryOpfsRoot();
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
  });
  afterEach(() => {
    vi.mocked(isTestModeEnabled).mockReturnValue(false);
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("writes and reads project files", async () => {
    const storage = await openedAdapter();
    await storage.writeText("project.json", '{"name":"test"}');
    expect(await storage.readText("project.json")).toBe('{"name":"test"}');
  });

  it("retries the project folder digest after a failure instead of remembering it", async () => {
    const digest = vi.spyOn(webcrypto.subtle, "digest").mockRejectedValueOnce(new Error("digest unavailable"));
    try {
      const storage = new OpfsStorageAdapter();
      await expect(storage.openDocumentsProject("Digest.hproject")).rejects.toThrow("digest unavailable");
      await expect(storage.openDocumentsProject("Digest.hproject")).resolves.toMatchObject({ name: "Digest.hproject" });
      await storage.writeText("project.json", "{}");
      expect(await storage.readText("project.json")).toBe("{}");
    } finally {
      digest.mockRestore();
    }
  });

  it("round-trips binary payloads", async () => {
    const storage = await openedAdapter();
    const bytes = new Uint8Array([0, 1, 2, 250]);
    await storage.writeBinary("blob.bin", bytes);
    expect(await storage.readBinary("blob.bin")).toEqual(bytes);
  });

  it("reads Blob slices without opening full inline payloads and rejects replaced revisions", async () => {
    const storage = await openedAdapter();
    const bytes = new Uint8Array(1024 * 1024);
    bytes.set([7, 8, 9], 64);
    await storage.writeBinary("large.hasset", bytes);
    const root = await navigator.storage.getDirectory();
    const file = await (await opfsProjectFolder(root, storage.getCurrentFolder()!.id)).getFileHandle("large.hasset");
    const getFile = file.getFile.bind(file);
    vi.spyOn(file, "getFile").mockImplementation(async () => {
      const snapshot = await getFile();
      snapshot.arrayBuffer = async () => { throw new Error("Whole file read forbidden"); };
      return snapshot;
    });
    const selected = await storage.readBinaryRange("large.hasset", 64, 3);
    expect(selected.bytes).toEqual(new Uint8Array([7, 8, 9]));
    expect(storage.getReadMetrics()).toMatchObject({ actualBytesRead: 3, fullReads: 0 });
    await storage.writeBinary("large.hasset", bytes);
    await expect(storage.readBinaryRange("large.hasset", 64, 3, selected.revision)).rejects.toThrow(/revision/i);
    await expect(storage.readBinaryRange("large.hasset", bytes.length, 1)).rejects.toThrow(/range/i);
  });

  it.each(["NotReadableError", "NotFoundError"])("classifies %s from an invalidated Blob slice only after confirming a replacement", async errorName => {
    const storage = await openedAdapter();
    await storage.writeBinary("asset.hasset", new Uint8Array([1, 2, 3, 4]));
    const root = await navigator.storage.getDirectory();
    const handle = await (await opfsProjectFolder(root, storage.getCurrentFolder()!.id)).getFileHandle("asset.hasset");
    const snapshot = await handle.getFile();
    const failure = new DOMException("Snapshot cannot be read", errorName);
    const slice = snapshot.slice.bind(snapshot);
    snapshot.slice = (...args) => Object.assign(slice(...args), { arrayBuffer: async () => {
      await storage.writeBinary("asset.hasset", new Uint8Array([4, 3, 2, 1]));
      throw failure;
    } });
    vi.spyOn(handle, "getFile").mockResolvedValueOnce(snapshot);
    await expect(storage.readBinaryRange("asset.hasset", 0, 2)).rejects.toBeInstanceOf(SourceRevisionChangedError);
    expect(storage.getReadMetrics()).toMatchObject({ rangeReads: 1, actualBytesRead: 0, fullReads: 0 });
    expect((await storage.readBinaryRange("asset.hasset", 0, 2)).bytes).toEqual(new Uint8Array([4, 3]));
  });

  it.each(["NotReadableError", "NotFoundError", "SecurityError"])("preserves genuine %s failures when the source revision is unchanged", async errorName => {
    const storage = await openedAdapter();
    await storage.writeBinary("asset.hasset", new Uint8Array([1, 2, 3, 4]));
    const root = await navigator.storage.getDirectory();
    const handle = await (await opfsProjectFolder(root, storage.getCurrentFolder()!.id)).getFileHandle("asset.hasset");
    const snapshot = await handle.getFile();
    const failure = new DOMException("Source revision changed", errorName);
    const slice = snapshot.slice.bind(snapshot);
    snapshot.slice = (...args) => Object.assign(slice(...args), { arrayBuffer: async () => { throw failure; } });
    vi.spyOn(handle, "getFile").mockResolvedValueOnce(snapshot);
    await expect(storage.readBinaryRange("asset.hasset", 0, 2)).rejects.toBe(failure);
    expect(storage.getReadMetrics()).toMatchObject({ rangeReads: 1, actualBytesRead: 0, fullReads: 0 });
  });

  it.each(["replaced", "unreadable"])("counts bytes in mounted views when the post-read source is %s", async state => {
    const storage = await openedAdapter();
    await storage.writeBinary("asset.hasset", new Uint8Array([1, 2, 3, 4]));
    const mounted = createMountedProjectStorage([{ path: "plugin", storage, sourcePath: "" }]);
    const root = await navigator.storage.getDirectory();
    const handle = await (await opfsProjectFolder(root, storage.getCurrentFolder()!.id)).getFileHandle("asset.hasset");
    const snapshot = await handle.getFile();
    const slice = snapshot.slice.bind(snapshot);
    snapshot.slice = (...args) => {
      const selected = slice(...args);
      const read = selected.arrayBuffer.bind(selected);
      return Object.assign(selected, { arrayBuffer: async () => {
        const bytes = await read();
        if (state === "replaced") await storage.writeBinary("asset.hasset", new Uint8Array([4, 3, 2, 1]));
        return bytes;
      } });
    };
    const getFile = vi.spyOn(handle, "getFile").mockResolvedValueOnce(snapshot);
    const original = new Error("Provider is unavailable", { cause: new Error("Disconnected") });
    if (state === "unreadable") getFile.mockRejectedValueOnce(original);
    const failure = mounted.readBinaryRange("plugin/asset.hasset", 0, 2);
    if (state === "replaced") await expect(failure).rejects.toBeInstanceOf(SourceRevisionChangedError);
    else await expect(failure).rejects.toBe(original);
    expect(storage.getReadMetrics()).toMatchObject({ rangeReads: 1, actualBytesRead: 2, fullReads: 0 });
    expect(mounted.getReadMetrics!()).toMatchObject({ rangeReads: 1, actualBytesRead: 2, fullReads: 0 });
  });

  it("createStorage returns OPFS adapter on web platform", () => {
    expect(createStorage()).toBeInstanceOf(OpfsStorageAdapter);
  });

  it("uses fixed project name when test mode is enabled", async () => {
    vi.mocked(isTestModeEnabled).mockReturnValue(true);
    const storage = new OpfsStorageAdapter();
    expect((await storage.pickProjectFolder()).name).toBe(TEST_PROJECT_NAME);
  });

  it("prompts for a folder name outside test mode", async () => {
    vi.stubGlobal("prompt", vi.fn(() => "Named.hproject"));
    const storage = new OpfsStorageAdapter();
    const folder = await storage.pickProjectFolder();
    expect(folder.name).toBe("Named.hproject");
    expect(folder.tier).toBe("opfs");
  });

  it("falls back to a default name when the prompt is dismissed", async () => {
    vi.stubGlobal("prompt", vi.fn(() => null));
    const storage = new OpfsStorageAdapter();
    expect((await storage.pickProjectFolder()).name).toBe("MyGame");
  });

  it("has no current folder until one is picked", async () => {
    const storage = new OpfsStorageAdapter();
    expect(storage.getCurrentFolder()).toBeNull();
    await storage.pickProjectFolder();
    expect(storage.getCurrentFolder()).not.toBeNull();
  });

  it("rejects file operations before a folder is selected", async () => {
    const storage = new OpfsStorageAdapter();
    await expect(storage.readText("a.json")).rejects.toThrow(
      "No project folder selected",
    );
    await expect(storage.writeText("a.json", "{}")).rejects.toThrow(
      "No project folder selected",
    );
    await expect(storage.exists("a.json")).rejects.toThrow(
      "No project folder selected",
    );
  });

  it("throws a named error for a missing file", async () => {
    const storage = await openedAdapter();
    await expect(storage.readText("missing.json")).rejects.toThrow(
      "File not found: missing.json",
    );
  });

  it("reports existence per path", async () => {
    const storage = await openedAdapter();
    await storage.writeText("scenes/main.scene.json", "{}");
    expect(await storage.exists("scenes/main.scene.json")).toBe(true);
    expect(await storage.exists("scenes/other.scene.json")).toBe(false);
  });

  it("treats only a missing path as absent", async () => {
    const storage = await openedAdapter();
    await storage.writeText("scenes/main.scene.json", "{}");
    expect(await storage.exists("scenes")).toBe(true);
    expect(await storage.stat("scenes")).toMatchObject({ isDir: true });
    // A file where a parent directory would be cannot contain the path.
    expect(await storage.exists("scenes/main.scene.json/child")).toBe(false);
    const missing = await storage.readBinary("missing.json").catch((error: unknown) => error);
    expect(isStorageNotFound(missing)).toBe(true);
    expect((missing as Error).message).toBe("File not found: missing.json");
    const removed = await storage.remove("missing.json").catch((error: unknown) => error);
    expect(isStorageNotFound(removed)).toBe(true);

    const root = await navigator.storage.getDirectory();
    const directory = await opfsProjectFolder(root, storage.getCurrentFolder()!.id);
    const failure = new DOMException("Handle state changed", "InvalidStateError");
    vi.spyOn(directory, "getFileHandle").mockRejectedValue(failure);
    await expect(storage.exists("project.json")).rejects.toThrow("Handle state changed");
    const read = await storage.readBinary("project.json").catch((error: unknown) => error);
    expect(isStorageNotFound(read)).toBe(false);
    expect((read as Error).cause).toBe(failure);
  });

  it("lists direct children and flags directories", async () => {
    const storage = await openedAdapter();
    await storage.writeText("project.json", "{}");
    await storage.writeText("scenes/main.scene.json", "{}");
    await storage.writeText("scenes/nested/deep.json", "{}");

    const root = await storage.readdir("");
    expect(root).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "project.json", isDir: false }),
        expect.objectContaining({ name: "scenes", isDir: true }),
      ]),
    );

    const scenes = await storage.readdir("scenes");
    expect(scenes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "main.scene.json", isDir: false }),
        expect.objectContaining({ name: "nested", isDir: true }),
      ]),
    );
  });

  it("lists an OPFS folder while a write's swap file comes and goes", async () => {
    const notFound = () => Promise.reject(new DOMException("gone", "NotFoundError"));
    const file = (size: number) => ({
      kind: "file",
      getFile: async () => ({ size, lastModified: 7 }),
    });
    // Chromium lists `<name>.crswap` while a writable is open (readable until it
    // closes); an entry removed after listing rejects getFile().
    const entries: Array<[string, unknown]> = [
      ["main.scene.hasset.crswap", file(5)],
      ["main.scene.hasset", file(3)],
      ["removed.hasset", { kind: "file", getFile: notFound }],
      ["Input", { kind: "directory" }],
      ["Backup.crswap", { kind: "directory" }],
    ];
    const project = {
      async *entries() {
        yield* entries;
      },
    };
    const root = { getDirectoryHandle: async () => project };
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
    const storage = new OpfsStorageAdapter();
    await storage.openDocumentsProject("Test.hproject");

    expect(await storage.readdir("")).toEqual([
      { name: "main.scene.hasset", isDir: false, size: 3, mtime: 7 },
      { name: "Input", isDir: true, size: null, mtime: null },
      { name: "Backup.crswap", isDir: true, size: null, mtime: null },
    ]);
  });

  /** A stubbed OPFS project whose `file.hasset` hands out each snapshot in turn. */
  async function adapterOverSnapshots(snapshots: Array<() => Promise<ArrayBuffer>>) {
    let reads = 0;
    const handle = {
      getFile: async () => {
        const read = snapshots[Math.min(reads, snapshots.length - 1)]!;
        reads += 1;
        return { arrayBuffer: read };
      },
    };
    const project = {
      getFileHandle: async (name: string) => {
        if (name !== "file.hasset") throw new DOMException("missing", "NotFoundError");
        return handle;
      },
    };
    const root = { getDirectoryHandle: async () => project };
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
    const storage = new OpfsStorageAdapter();
    await storage.openDocumentsProject("Test.hproject");
    return { storage, reads: () => reads };
  }

  it("reads the saved file when a write replaces it between getFile() and the read", async () => {
    // Chromium fails a getFile() snapshot once a writable closes over the file:
    // NotReadableError, or NotFoundError when the old contents are already gone.
    for (const name of ["NotReadableError", "NotFoundError"]) {
      const { storage } = await adapterOverSnapshots([
        () => Promise.reject(new DOMException("stale snapshot", name)),
        async () => new Uint8Array([4, 5, 6]).buffer,
      ]);
      expect(await storage.readBinary("file.hasset")).toEqual(new Uint8Array([4, 5, 6]));
    }
  });

  it("reports a file that stays unreadable by its error, and a missing one as not found", async () => {
    const { storage, reads } = await adapterOverSnapshots([
      () => Promise.reject(new DOMException("stale snapshot", "NotReadableError")),
    ]);
    const unreadable = storage.readBinary("file.hasset");
    await expect(unreadable).rejects.toThrow(/NotReadableError/);
    await expect(unreadable).rejects.not.toThrow(/File not found/);
    // Retried with fresh snapshots before giving up.
    expect(reads()).toBeGreaterThan(1);
    await expect(storage.readBinary("missing.hasset")).rejects.toThrow(
      "File not found: missing.hasset",
    );
  });

  it("treats a trailing slash and dot as the same directory", async () => {
    const storage = await openedAdapter();
    await storage.writeText("scenes/main.scene.json", "{}");
    expect(await storage.readdir("scenes/")).toEqual(
      await storage.readdir("scenes"),
    );
    expect(await storage.readdir(".")).toEqual(await storage.readdir(""));
  });

  it("creates directories", async () => {
    const storage = await openedAdapter();
    await storage.mkdir("assets");
    await storage.writeText("assets/x.txt", "1");
    expect(await storage.exists("assets/x.txt")).toBe(true);
  });

  it("requires an existing parent when creating a directory nonrecursively", async () => {
    const storage = await openedAdapter();
    await expect(storage.mkdir("missing/child", false)).rejects.toThrow();
    expect(await storage.exists("missing")).toBe(false);
    await storage.mkdir("parent", false);
    await storage.mkdir("parent/child", false);
    expect((await storage.stat("parent/child")).isDir).toBe(true);
    await storage.mkdir("nested/child");
    expect((await storage.stat("nested/child")).isDir).toBe(true);
  });

  it("persists project meta across adapter instances", async () => {
    const storage = await openedAdapter();
    await storage.writeText("project.json", '{"persisted":true}');
    const name = storage.getCurrentFolder()!.name;

    const reopened = new OpfsStorageAdapter();
    expect(reopened.getCurrentFolder()?.name).toBe(name);
    expect(reopened.getCurrentFolder()).not.toBeNull();
    expect(await reopened.readText("project.json")).toBe('{"persisted":true}');
  });

  it("removes files", async () => {
    const storage = await openedAdapter();
    await storage.writeText("gone.txt", "x");
    await storage.remove("gone.txt");
    expect(await storage.exists("gone.txt")).toBe(false);
  });

  it("reopens a known OPFS project without prompting", async () => {
    const storage = await openedAdapter();
    await storage.writeText("keep.txt", "yes");
    const handle = storage.getCurrentFolder()!;
    await storage.releaseFolder();

    await storage.openKnownFolder(handle);
    expect(await storage.readText("keep.txt")).toBe("yes");
  });

  it("rejects openKnownFolder for non-opfs tiers", async () => {
    const storage = new OpfsStorageAdapter();
    await expect(
      storage.openKnownFolder({
        id: "documents:x",
        name: "x",
        tier: "documents",
      }),
    ).rejects.toThrow(/cannot open tier/);
  });

  it("deleteProject drops the OPFS folder and meta so a rebind is empty", async () => {
    const storage = await openedAdapter();
    await storage.writeText("project.json", '{"old":true}');
    const handle = storage.getCurrentFolder()!;
    await storage.deleteProject(handle);
    expect(await storage.listProjects()).toEqual([]);
    expect(storage.getCurrentFolder()).toBeNull();

    const again = new OpfsStorageAdapter();
    expect(await again.listProjects()).toEqual([]);
    await again.openKnownFolder(handle);
    expect(await again.exists("project.json")).toBe(false);
  });

  it("reports unavailable or denied persistent storage instead of accepting volatile saves", async () => {
    vi.stubGlobal("navigator", {});
    await expect(new OpfsStorageAdapter().openDocumentsProject("Unavailable")).rejects.toThrow(/storage.*unavailable/i);
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => { throw new DOMException("Storage denied", "SecurityError"); } } });
    const storage = new OpfsStorageAdapter();
    await expect(storage.openDocumentsProject("Denied")).rejects.toThrow("Storage denied");
    expect(storage.getCurrentFolder()).toBeNull();
    expect(await storage.listProjects()).toEqual([]);
  });

  it("keeps colliding display names in independent folders across reopen and deletion", async () => {
    const storage = new OpfsStorageAdapter();
    const first = await storage.openDocumentsProject("My Game");
    await storage.writeText("project.json", "first");
    const second = await storage.openDocumentsProject("My_Game");
    expect(await storage.exists("project.json")).toBe(false);
    await storage.writeText("project.json", "second");
    const reopened = new OpfsStorageAdapter();
    await reopened.openKnownFolder(first);
    expect(await reopened.readText("project.json")).toBe("first");
    await reopened.deleteProject(second);
    expect(await reopened.readText("project.json")).toBe("first");
  });

  it("does not recreate a deleted project when a later save arrives", async () => {
    const storage = await openedAdapter();
    await storage.writeText("project.json", "saved");
    await new OpfsStorageAdapter().deleteProject(storage.getCurrentFolder()!);
    const save = await storage.writeText("scenes/main.scene.json", "{}").catch((error: unknown) => error);
    expect(isStorageNotFound(save)).toBe(true);
    expect(await storage.exists("project.json")).toBe(false);
    expect(await new OpfsStorageAdapter().listProjects()).toEqual([]);
  });

  it("keeps the committed revision when a write fails", async () => {
    const storage = await openedAdapter();
    await storage.writeBinary("asset.hasset", new Uint8Array([1, 2, 3, 4]));
    const before = await storage.readBinaryRange("asset.hasset", 0, 2);
    const root = await navigator.storage.getDirectory();
    const file = await (await opfsProjectFolder(root, storage.getCurrentFolder()!.id)).getFileHandle("asset.hasset");
    vi.spyOn(file, "createWritable").mockResolvedValueOnce({
      write: async () => { throw new DOMException("Storage is full", "QuotaExceededError"); },
      close: async () => {},
      abort: async () => {},
    } as unknown as FileSystemWritableFileStream);
    await expect(storage.writeBinary("asset.hasset", new Uint8Array([9, 9, 9, 9]))).rejects.toThrow("Storage is full");
    expect((await storage.readBinaryRange("asset.hasset", 2, 2, before.revision)).bytes).toEqual(new Uint8Array([3, 4]));
  });

  it("never gives new bytes a revision read while an overlapping write that later failed was staged", async () => {
    const storage = await openedAdapter();
    await storage.writeBinary("asset.hasset", new Uint8Array([1, 2, 3, 4]));
    const root = await navigator.storage.getDirectory();
    const file = await (await opfsProjectFolder(root, storage.getCurrentFolder()!.id)).getFileHandle("asset.hasset");
    // Writes within one millisecond keep lastModified, so only the write counter tells them apart.
    const getFile = file.getFile.bind(file);
    vi.spyOn(file, "getFile").mockImplementation(async () => Object.assign(await getFile(), { lastModified: 0 }));
    const createWritable = file.createWritable.bind(file);
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      return { promise, resolve };
    };
    const [firstStaged, secondStaged, releaseFirst, failSecond] = [deferred(), deferred(), deferred(), deferred()];
    vi.spyOn(file, "createWritable")
      .mockImplementationOnce(async () => {
        const writable = await createWritable();
        return {
          write: async (data: FileSystemWriteChunkType) => {
            firstStaged.resolve();
            await releaseFirst.promise;
            await writable.write(data);
          },
          close: () => writable.close(),
          abort: () => writable.abort(),
        } as unknown as FileSystemWritableFileStream;
      })
      .mockImplementationOnce(async () => ({
        write: async () => {
          secondStaged.resolve();
          await failSecond.promise;
          throw new DOMException("Storage is full", "QuotaExceededError");
        },
        close: async () => {},
        abort: async () => {},
      }) as unknown as FileSystemWritableFileStream);
    const first = storage.writeBinary("asset.hasset", new Uint8Array([5, 6, 7, 8]));
    await firstStaged.promise;
    const second = storage.writeBinary("asset.hasset", new Uint8Array([9, 9, 9, 9]));
    await secondStaged.promise;
    const during = await storage.readBinaryRange("asset.hasset", 0, 2);
    expect(during.bytes).toEqual(new Uint8Array([1, 2]));
    failSecond.resolve();
    await expect(second).rejects.toThrow("Storage is full");
    releaseFirst.resolve();
    await first;
    await expect(storage.readBinaryRange("asset.hasset", 0, 2, during.revision)).rejects.toBeInstanceOf(SourceRevisionChangedError);
  });

  it("rejects parent segments and directories it cannot list", async () => {
    const storage = await openedAdapter();
    await storage.writeText("scenes/main.scene.json", "{}");
    await expect(storage.readText("scenes/../project.json")).rejects.toThrow(/escapes project root/);
    await expect(storage.writeText("../outside.json", "{}")).rejects.toThrow(/escapes project root/);
    const root = { getDirectoryHandle: async () => ({}) };
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
    const unlistable = new OpfsStorageAdapter();
    await unlistable.openDocumentsProject("Test.hproject");
    await expect(unlistable.readdir("")).rejects.toThrow(/iteration is unavailable/);
  });

  it("keeps a different project registered while deleting an older project", async () => {
    const storage = await openedAdapter();
    const root = await navigator.storage.getDirectory();
    let entered!: () => void;
    let release!: () => void;
    const removing = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const remove = root.removeEntry.bind(root);
    vi.spyOn(root, "removeEntry").mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return remove(...args);
    });
    const deletion = storage.deleteProject(storage.getCurrentFolder()!);
    await removing;
    const other = new OpfsStorageAdapter();
    const next = await other.openDocumentsProject("New Project");
    await other.writeText("project.json", "new project");
    release();
    await deletion;
    const reopened = new OpfsStorageAdapter();
    expect(await reopened.listProjects()).toEqual([next]);
    expect(await reopened.readText("project.json")).toBe("new project");
  });

  it("keeps saved data and project metadata available when writes or deletion are denied", async () => {
    const storage = await openedAdapter();
    await storage.writeText("project.json", "original");
    const root = await navigator.storage.getDirectory();
    const directory = await opfsProjectFolder(root, storage.getCurrentFolder()!.id);
    const file = await directory.getFileHandle("project.json");
    vi.spyOn(file, "createWritable").mockRejectedValueOnce(new DOMException("Storage is full", "QuotaExceededError"));
    await expect(storage.writeText("project.json", "changed")).rejects.toThrow("Storage is full");
    vi.spyOn(root, "removeEntry").mockRejectedValueOnce(new DOMException("Deletion denied", "NotAllowedError"));
    await expect(storage.deleteProject(storage.getCurrentFolder()!)).rejects.toThrow("Deletion denied");
    const reopened = new OpfsStorageAdapter();
    expect(await reopened.listProjects()).toHaveLength(1);
    expect(await reopened.readText("project.json")).toBe("original");
  });
});

/** Each adapter stands for a tab: they share the origin's OPFS, localStorage and Web Locks. */
describe("OPFS project session lock", () => {
  let root: FileSystemDirectoryHandle;
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    root = createMemoryOpfsRoot();
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root }, locks: createFakeWebLocks() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("opens a project in one tab at a time and frees it when that tab closes it", async () => {
    const first = new OpfsStorageAdapter();
    const handle = await first.openDocumentsProject("Shared");
    await first.writeText("project.json", "first tab");

    const second = new OpfsStorageAdapter();
    const refused = await second.openKnownFolder(handle).catch((error: unknown) => error);
    expect(isProjectOpenElsewhere(refused)).toBe(true);
    expect((refused as Error).message).toBe("This project is open in another tab. Close it there and try again.");
    await second.openDocumentsProject("Other");

    await first.releaseFolder();
    await second.openKnownFolder(handle);
    expect(await second.readText("project.json")).toBe("first tab");
    expect(isProjectOpenElsewhere(await first.openKnownFolder(handle).catch((error: unknown) => error))).toBe(true);
    await second.releaseFolder();
    await first.openKnownFolder(handle);
  });

  it("keeps the bound project locked and usable when another bind is refused", async () => {
    const other = new OpfsStorageAdapter();
    const taken = await other.openDocumentsProject("Taken");
    const storage = new OpfsStorageAdapter();
    const own = await storage.openDocumentsProject("Own");
    await expect(storage.openKnownFolder(taken)).rejects.toSatisfy(isProjectOpenElsewhere);
    expect(storage.getCurrentFolder()).toEqual(own);
    await storage.writeText("project.json", "still mine");
    await expect(new OpfsStorageAdapter().openKnownFolder(own)).rejects.toSatisfy(isProjectOpenElsewhere);
  });

  it("releases the previous project when the adapter binds another, and rebinds its own", async () => {
    const storage = new OpfsStorageAdapter();
    const first = await storage.openDocumentsProject("First");
    await storage.openDocumentsProject("First");
    await storage.openDocumentsProject("Second");
    await new OpfsStorageAdapter().openKnownFolder(first);
  });

  it("releases the project when binding fails", async () => {
    vi.spyOn(root, "getDirectoryHandle").mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    const storage = new OpfsStorageAdapter();
    await expect(storage.openDocumentsProject("Flaky")).rejects.toThrow("Denied");
    await new OpfsStorageAdapter().openDocumentsProject("Flaky");
  });

  it("leaves app libraries shared between tabs", async () => {
    const first = new OpfsStorageAdapter({ library: true });
    await first.openDocumentsProject("__haptic_derived__");
    const second = new OpfsStorageAdapter({ library: true });
    await second.openDocumentsProject("__haptic_derived__");
    await second.writeText("cache.json", "{}");
    expect(await first.readText("cache.json")).toBe("{}");
  });

  it("deletes only projects this tab owns or that no tab has open", async () => {
    const other = new OpfsStorageAdapter();
    const open = await other.openDocumentsProject("OpenElsewhere");
    await other.writeText("project.json", "keep");
    const idle = await other.openDocumentsProject("Idle");
    await other.releaseFolder();

    const storage = new OpfsStorageAdapter();
    await other.openKnownFolder(open);
    await expect(storage.deleteProject(open)).rejects.toSatisfy(isProjectOpenElsewhere);
    expect(await other.readText("project.json")).toBe("keep");

    await storage.deleteProject(idle);
    expect((await storage.listProjects()).map((project) => project.id)).toEqual([open.id]);
    await storage.openDocumentsProject("Idle");

    await other.deleteProject(open);
    await storage.openKnownFolder(open);
    expect(await storage.exists("project.json")).toBe(false);
  });

  it("keeps its own project locked when its deletion fails", async () => {
    const storage = new OpfsStorageAdapter();
    const handle = await storage.openDocumentsProject("Stubborn");
    vi.spyOn(root, "removeEntry").mockRejectedValueOnce(new DOMException("Deletion denied", "NotAllowedError"));
    await expect(storage.deleteProject(handle)).rejects.toThrow("Deletion denied");
    await expect(new OpfsStorageAdapter().openKnownFolder(handle)).rejects.toSatisfy(isProjectOpenElsewhere);
  });
});
