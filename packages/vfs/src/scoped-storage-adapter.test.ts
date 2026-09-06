import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BabylonSlateScopedStoragePlugin } from "./capacitor-scoped-storage";
import { ScopedStorageAdapter } from "./scoped-storage-adapter";

const prefs = new Map<string, string>();

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: prefs.get(key) ?? null,
    })),
    set: vi.fn(
      async ({ key, value }: { key: string; value: string }) => {
        prefs.set(key, value);
      },
    ),
    remove: vi.fn(async ({ key }: { key: string }) => {
      prefs.delete(key);
    }),
  },
}));

function createMockPlugin(): BabylonSlateScopedStoragePlugin {
  return {
    pickFolder: vi.fn(),
    openFolder: vi.fn(),
    importBookmark: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    deleteFile: vi.fn(),
    rmdir: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    exists: vi.fn(),
  } as unknown as BabylonSlateScopedStoragePlugin;
}

describe("ScopedStorageAdapter", () => {
  beforeEach(() => {
    prefs.clear();
  });

  it("loads a persisted folder on init", async () => {
    prefs.set(
      "babylonslate:scoped-folder",
      JSON.stringify({ id: "folder-1", name: "My Game" }),
    );
    const plugin = createMockPlugin();
    const adapter = new ScopedStorageAdapter(plugin);

    await adapter.init();

    expect(adapter.getCurrentFolder()).toEqual({
      id: "folder-1",
      name: "My Game",
      tier: "external",
    });
    expect(plugin.openFolder).not.toHaveBeenCalled();
  });

  it("migrates a legacy bookmark id to a stable folder id on init", async () => {
    const legacyBookmark = btoa("a-legacy-security-scoped-bookmark-that-is-long");
    prefs.set(
      "babylonslate:scoped-folder",
      JSON.stringify({ id: legacyBookmark, name: "Legacy" }),
    );
    const plugin = createMockPlugin();
    vi.mocked(plugin.importBookmark!).mockResolvedValue({
      folder: { id: "uuid-1", name: "Legacy" },
    });
    const adapter = new ScopedStorageAdapter(plugin);

    await adapter.init();

    expect(plugin.importBookmark).toHaveBeenCalledWith({
      bookmark: legacyBookmark,
      name: "Legacy",
    });
    expect(adapter.getCurrentFolder()).toEqual({
      id: "uuid-1",
      name: "Legacy",
      tier: "external",
    });
    expect(prefs.get("babylonslate:scoped-folder")).toContain("uuid-1");
  });

  it("picks a folder and stores a stable folder handle", async () => {
    const plugin = createMockPlugin();
    vi.mocked(plugin.pickFolder).mockResolvedValue({
      folder: { id: "uuid-2", name: "World" },
    });
    const adapter = new ScopedStorageAdapter(plugin);

    const handle = await adapter.pickProjectFolder();

    expect(handle).toEqual({
      id: "uuid-2",
      name: "World",
      tier: "external",
    });
    expect(prefs.get("babylonslate:scoped-folder")).toBe(
      JSON.stringify({ id: "uuid-2", name: "World" }),
    );
    expect(adapter.getCurrentFolder()).toEqual(handle);
  });

  it("throws CANCELLED when picking is cancelled", async () => {
    const plugin = createMockPlugin();
    vi.mocked(plugin.pickFolder).mockRejectedValue({ code: "CANCELLED" });
    const adapter = new ScopedStorageAdapter(plugin);

    await expect(adapter.pickProjectFolder()).rejects.toEqual({
      code: "CANCELLED",
    });
  });

  it("opens a known external folder and clears stale state", async () => {
    prefs.set(
      "babylonslate:scoped-stale",
      "1",
    );
    const plugin = createMockPlugin();
    vi.mocked(plugin.openFolder).mockResolvedValue({
      folder: { id: "uuid-3", name: "Reopened" },
    });
    const adapter = new ScopedStorageAdapter(plugin);

    const handle = await adapter.openKnownFolder({
      id: "uuid-3",
      name: "Old",
      tier: "external",
    });

    expect(plugin.openFolder).toHaveBeenCalledWith({ id: "uuid-3" });
    expect(handle).toEqual({
      id: "uuid-3",
      name: "Reopened",
      tier: "external",
    });
    expect(adapter.getCurrentFolder()).toEqual(handle);
    expect(adapter.needsReconnect()).resolves.toBe(false);
  });

  it("reads text from the current external folder", async () => {
    const plugin = createMockPlugin();
    prefs.set(
      "babylonslate:scoped-folder",
      JSON.stringify({ id: "uuid-4", name: "Game" }),
    );
    vi.mocked(plugin.readFile).mockResolvedValue({ data: "hello" });
    const adapter = new ScopedStorageAdapter(plugin);
    await adapter.init();

    const text = await adapter.readText("notes.txt");

    expect(text).toBe("hello");
    expect(plugin.readFile).toHaveBeenCalledWith({
      folder: "uuid-4",
      path: "notes.txt",
      encoding: "utf8",
    });
  });

  it("writes text to the current external folder", async () => {
    const plugin = createMockPlugin();
    prefs.set(
      "babylonslate:scoped-folder",
      JSON.stringify({ id: "uuid-5", name: "Game" }),
    );
    vi.mocked(plugin.writeFile).mockResolvedValue(undefined);
    const adapter = new ScopedStorageAdapter(plugin);
    await adapter.init();

    await adapter.writeText("notes.txt", "hello");

    expect(plugin.writeFile).toHaveBeenCalledWith({
      folder: "uuid-5",
      path: "notes.txt",
      data: "hello",
      encoding: "utf8",
    });
  });

  it("reads and writes binary as base64", async () => {
    const plugin = createMockPlugin();
    prefs.set(
      "babylonslate:scoped-folder",
      JSON.stringify({ id: "uuid-6", name: "Game" }),
    );
    const bytes = new Uint8Array([0x00, 0x7f, 0xff]);
    vi.mocked(plugin.readFile).mockResolvedValue({
      data: btoa(String.fromCharCode(...bytes)),
    });
    vi.mocked(plugin.writeFile).mockResolvedValue(undefined);
    const adapter = new ScopedStorageAdapter(plugin);
    await adapter.init();

    await adapter.writeBinary("data.bin", bytes);
    const read = await adapter.readBinary("data.bin");

    expect(read).toEqual(bytes);
    expect(plugin.writeFile).toHaveBeenCalledWith({
      folder: "uuid-6",
      path: "data.bin",
      data: btoa(String.fromCharCode(...bytes)),
      encoding: "base64",
    });
    expect(plugin.readFile).toHaveBeenCalledWith({
      folder: "uuid-6",
      path: "data.bin",
      encoding: "base64",
    });
  });

  it("lists entries from the plugin and maps isDir", async () => {
    const plugin = createMockPlugin();
    prefs.set(
      "babylonslate:scoped-folder",
      JSON.stringify({ id: "uuid-7", name: "Game" }),
    );
    vi.mocked(plugin.readdir).mockResolvedValue({
      entries: [
        { name: "assets", isDir: true },
        { name: "main.ts", isDir: false, size: 12, mtime: 1_700_000_000_000 },
      ],
    });
    const adapter = new ScopedStorageAdapter(plugin);
    await adapter.init();

    const entries = await adapter.readdir("src");

    expect(entries).toEqual([
      { name: "assets", isDir: true, size: null, mtime: null },
      {
        name: "main.ts",
        isDir: false,
        size: 12,
        mtime: 1_700_000_000_000,
      },
    ]);
  });

  it("maps NOT_FOUND plugin errors to a clear file message", async () => {
    const plugin = createMockPlugin();
    prefs.set(
      "babylonslate:scoped-folder",
      JSON.stringify({ id: "uuid-8", name: "Game" }),
    );
    vi.mocked(plugin.readFile).mockRejectedValue({
      code: "NOT_FOUND",
      message: "missing",
    });
    const adapter = new ScopedStorageAdapter(plugin);
    await adapter.init();

    await expect(adapter.readText("gone.txt")).rejects.toThrow(
      "File not found: gone.txt",
    );
  });

  it("marks the folder stale and persists the flag on STALE", async () => {
    const plugin = createMockPlugin();
    prefs.set(
      "babylonslate:scoped-folder",
      JSON.stringify({ id: "uuid-9", name: "Game" }),
    );
    vi.mocked(plugin.readFile).mockRejectedValue({
      code: "STALE",
      message: "bookmark stale",
    });
    const adapter = new ScopedStorageAdapter(plugin);
    await adapter.init();

    await expect(adapter.readText("x")).rejects.toEqual({
      code: "STALE",
      message: "bookmark stale",
    });
    expect(adapter.needsReconnect()).resolves.toBe(true);
    expect(prefs.get("babylonslate:scoped-stale")).toBe("1");
  });

  it("removes files with deleteFile and directories with rmdir", async () => {
    const plugin = createMockPlugin();
    prefs.set(
      "babylonslate:scoped-folder",
      JSON.stringify({ id: "uuid-10", name: "Game" }),
    );
    vi.mocked(plugin.exists)
      .mockResolvedValueOnce({ exists: true, isDirectory: false })
      .mockResolvedValueOnce({ exists: true, isDirectory: true })
      .mockResolvedValueOnce({ exists: true, isDirectory: false });
    vi.mocked(plugin.deleteFile).mockResolvedValue(undefined);
    vi.mocked(plugin.rmdir).mockResolvedValue(undefined);
    const adapter = new ScopedStorageAdapter(plugin);
    await adapter.init();

    await adapter.remove("file.txt");
    await adapter.remove("dir");

    expect(plugin.deleteFile).toHaveBeenCalledWith({
      folder: "uuid-10",
      path: "file.txt",
    });
    expect(plugin.rmdir).toHaveBeenCalledWith({
      folder: "uuid-10",
      path: "dir",
      recursive: true,
    });
  });

  it("throws a plain message when removing a missing path", async () => {
    const plugin = createMockPlugin();
    prefs.set(
      "babylonslate:scoped-folder",
      JSON.stringify({ id: "uuid-11", name: "Game" }),
    );
    vi.mocked(plugin.exists).mockResolvedValue({
      exists: false,
      isDirectory: false,
    });
    const adapter = new ScopedStorageAdapter(plugin);
    await adapter.init();

    await expect(adapter.remove("missing")).rejects.toThrow(
      "File not found: missing",
    );
  });
});
