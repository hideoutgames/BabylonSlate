import { describe, expect, it, vi, afterEach } from "vitest";
import { createStorage } from "./create-storage";
import { TEST_PROJECT_NAME } from "./test-mode";
import { OpfsStorageAdapter, WebStorageAdapter } from "./web-adapter";

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
  await storage.openDocumentsProject("Test.babproject");
  return storage;
}

describe("OPFS / web storage adapter", () => {
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

  it("round-trips binary payloads", async () => {
    const storage = await openedAdapter();
    const bytes = new Uint8Array([0, 1, 2, 250]);
    await storage.writeBinary("blob.bin", bytes);
    expect(await storage.readBinary("blob.bin")).toEqual(bytes);
  });

  it("createStorage returns OPFS adapter on web platform", () => {
    expect(createStorage()).toBeInstanceOf(OpfsStorageAdapter);
  });

  it("WebStorageAdapter remains an OpfsStorageAdapter alias", () => {
    expect(new WebStorageAdapter()).toBeInstanceOf(OpfsStorageAdapter);
  });

  it("uses fixed project name when test mode is enabled", async () => {
    vi.mocked(isTestModeEnabled).mockReturnValue(true);
    const storage = new OpfsStorageAdapter();
    expect((await storage.pickProjectFolder()).name).toBe(TEST_PROJECT_NAME);
  });

  it("prompts for a folder name outside test mode", async () => {
    vi.stubGlobal("prompt", vi.fn(() => "Named.babproject"));
    const storage = new OpfsStorageAdapter();
    const folder = await storage.pickProjectFolder();
    expect(folder.name).toBe("Named.babproject");
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
      ["main.scene.babasset.crswap", file(5)],
      ["main.scene.babasset", file(3)],
      ["removed.babasset", { kind: "file", getFile: notFound }],
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
    await storage.openDocumentsProject("Test.babproject");

    expect(await storage.readdir("")).toEqual([
      { name: "main.scene.babasset", isDir: false, size: 3, mtime: 7 },
      { name: "Input", isDir: true, size: null, mtime: null },
      { name: "Backup.crswap", isDir: true, size: null, mtime: null },
    ]);
  });

  /** A stubbed OPFS project whose `file.babasset` hands out each snapshot in turn. */
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
        if (name !== "file.babasset") throw new DOMException("missing", "NotFoundError");
        return handle;
      },
    };
    const root = { getDirectoryHandle: async () => project };
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => root } });
    const storage = new OpfsStorageAdapter();
    await storage.openDocumentsProject("Test.babproject");
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
      expect(await storage.readBinary("file.babasset")).toEqual(new Uint8Array([4, 5, 6]));
    }
  });

  it("reports a file that stays unreadable by its error, and a missing one as not found", async () => {
    const { storage, reads } = await adapterOverSnapshots([
      () => Promise.reject(new DOMException("stale snapshot", "NotReadableError")),
    ]);
    const unreadable = storage.readBinary("file.babasset");
    await expect(unreadable).rejects.toThrow(/NotReadableError/);
    await expect(unreadable).rejects.not.toThrow(/File not found/);
    // Retried a bounded number of times, then given up.
    expect(reads()).toBe(4);
    await expect(storage.readBinary("missing.babasset")).rejects.toThrow(
      "File not found: missing.babasset",
    );
    expect(reads()).toBe(4);
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

  it("persists project meta across adapter instances", async () => {
    const storage = await openedAdapter();
    await storage.writeText("project.json", '{"persisted":true}');
    const name = storage.getCurrentFolder()!.name;

    const reopened = new OpfsStorageAdapter();
    expect(reopened.getCurrentFolder()?.name).toBe(name);
    // Memory fallback does not share heaps across instances; meta restores handle.
    expect(reopened.getCurrentFolder()).not.toBeNull();
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

    // Same adapter instance: jsdom OPFS memory fallback is per-instance;
    // Playwright covers durable OPFS across page reloads.
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
});
