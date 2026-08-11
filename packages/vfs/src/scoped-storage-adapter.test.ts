import { beforeEach, describe, expect, it, vi } from "vitest";

const prefs = new Map<string, string>();

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: prefs.get(key) ?? null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      prefs.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      prefs.delete(key);
    }),
  },
}));

const pickFolder = vi.fn(async () => ({
  folder: { id: "bookmark-1", name: "Repo.babproject" },
}));
const readFile = vi.fn<(opts: unknown) => Promise<{ data: string }>>(
  async () => ({ data: "hello" }),
);
const writeFile = vi.fn<(opts: unknown) => Promise<unknown>>(async () => ({}));
const exists = vi.fn<(opts: unknown) => Promise<{ exists: boolean }>>(
  async () => ({ exists: true }),
);
const readdir = vi.fn<
  (opts: unknown) => Promise<{
    entries: Array<{
      name: string;
      isDir: boolean;
      size: number;
      mtime: number;
    }>;
  }>
>(async () => ({
  entries: [{ name: "project.json", isDir: false, size: 3, mtime: 1 }],
}));
const mkdir = vi.fn<(opts: unknown) => Promise<unknown>>(async () => ({}));

vi.mock("@daniele-rolli/capacitor-scoped-storage", () => ({
  ScopedStorage: {
    pickFolder: () => pickFolder(),
    readFile: (opts: unknown) => readFile(opts),
    writeFile: (opts: unknown) => writeFile(opts),
    exists: (opts: unknown) => exists(opts),
    readdir: (opts: unknown) => readdir(opts),
    mkdir: (opts: unknown) => mkdir(opts),
  },
}));

const { ScopedStorageAdapter } = await import("./scoped-storage-adapter");

describe("external tier (scoped storage)", () => {
  beforeEach(() => {
    prefs.clear();
    vi.clearAllMocks();
    pickFolder.mockResolvedValue({
      folder: { id: "bookmark-1", name: "Repo.babproject" },
    });
    readFile.mockResolvedValue({ data: "hello" });
    exists.mockResolvedValue({ exists: true });
  });

  it("binds a folder through the picker and persists the bookmark", async () => {
    const adapter = new ScopedStorageAdapter();
    const handle = await adapter.pickProjectFolder();

    expect(handle).toEqual({
      id: "bookmark-1",
      name: "Repo.babproject",
      tier: "external",
    });
    expect(prefs.get("babylonslate:scoped-folder")).toContain("bookmark-1");
  });

  it("restores the bookmark on init without showing the picker", async () => {
    const first = new ScopedStorageAdapter();
    await first.pickProjectFolder();

    const next = new ScopedStorageAdapter();
    await next.init();
    pickFolder.mockClear();

    expect(next.getCurrentFolder()?.id).toBe("bookmark-1");
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it("reopens a listed external project without re-prompting", async () => {
    const adapter = new ScopedStorageAdapter();
    const handle = await adapter.pickProjectFolder();
    pickFolder.mockClear();

    const reopened = await adapter.openKnownFolder(handle);
    expect(reopened).toEqual(handle);
    expect(pickFolder).not.toHaveBeenCalled();
    expect(await adapter.listProjects()).toEqual([handle]);
  });

  it("rebinds a bookmark from another session without the picker", async () => {
    const adapter = new ScopedStorageAdapter();
    const reopened = await adapter.openKnownFolder({
      id: "bookmark-2",
      name: "Other.babproject",
      tier: "external",
    });
    expect(reopened.id).toBe("bookmark-2");
    expect(pickFolder).not.toHaveBeenCalled();
    expect(prefs.get("babylonslate:scoped-folder")).toContain("bookmark-2");
  });

  it("refuses tiers it does not own", async () => {
    const adapter = new ScopedStorageAdapter();
    await expect(
      adapter.openKnownFolder({ id: "x", name: "x", tier: "documents" }),
    ).rejects.toThrow(/cannot open tier/);
    await expect(adapter.openDocumentsProject("x")).rejects.toThrow(
      /DocumentsStorageAdapter/,
    );
  });

  it("reads and writes text and binary through the plugin", async () => {
    const adapter = new ScopedStorageAdapter();
    await adapter.pickProjectFolder();

    expect(await adapter.readText("project.json")).toBe("hello");
    await adapter.writeText("project.json", "{}");
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "project.json", encoding: "utf8" }),
    );

    readFile.mockResolvedValue({ data: btoa("\u0001\u0002") });
    expect(await adapter.readBinary("blob.bin")).toEqual(
      new Uint8Array([1, 2]),
    );
    await adapter.writeBinary("blob.bin", new Uint8Array([3]));
    expect(writeFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ encoding: "base64" }),
    );
  });

  it("lists directory entries and stats a file", async () => {
    const adapter = new ScopedStorageAdapter();
    await adapter.pickProjectFolder();

    expect(await adapter.readdir("")).toEqual([
      { name: "project.json", isDir: false, size: 3, mtime: 1 },
    ]);
    expect(await adapter.stat("project.json")).toEqual({
      isDir: false,
      size: 3,
      mtime: 1,
    });
    await adapter.mkdir("assets");
    expect(mkdir).toHaveBeenCalled();
  });

  it("surfaces a stale bookmark as needsReconnect instead of a raw error", async () => {
    const adapter = new ScopedStorageAdapter();
    await adapter.pickProjectFolder();
    readFile.mockRejectedValue(new Error("security-scoped bookmark is stale"));

    await expect(adapter.readText("project.json")).rejects.toThrow(
      /reconnect required/,
    );
    expect(await adapter.needsReconnect()).toBe(true);
    expect(await adapter.listProjects()).toEqual([]);
  });

  it("refuses reopen while the bookmark is stale, then recovers via Reconnect", async () => {
    const adapter = new ScopedStorageAdapter();
    const handle = await adapter.pickProjectFolder();
    await adapter.markStale();

    await expect(adapter.openKnownFolder(handle)).rejects.toThrow(/stale/);

    const reconnected = await adapter.reconnectFolder();
    expect(reconnected.id).toBe("bookmark-1");
    expect(await adapter.needsReconnect()).toBe(false);
  });

  it("clears the bookmark when the folder is released", async () => {
    const adapter = new ScopedStorageAdapter();
    await adapter.pickProjectFolder();
    await adapter.releaseFolder();

    expect(adapter.getCurrentFolder()).toBeNull();
    expect(prefs.has("babylonslate:scoped-folder")).toBe(false);
    await expect(adapter.readText("project.json")).rejects.toThrow(
      /No project folder selected/,
    );
  });

  it("reports a missing file from stat", async () => {
    const adapter = new ScopedStorageAdapter();
    await adapter.pickProjectFolder();
    exists.mockResolvedValue({ exists: false });

    expect(await adapter.exists("nope.json")).toBe(false);
    await expect(adapter.stat("nope.json")).rejects.toThrow(/File not found/);
  });

  it("reports when the plugin cannot delete files", async () => {
    const adapter = new ScopedStorageAdapter();
    await adapter.pickProjectFolder();
    await expect(adapter.remove("project.json")).rejects.toThrow(
      /not supported by scoped-storage plugin/,
    );
  });
});
