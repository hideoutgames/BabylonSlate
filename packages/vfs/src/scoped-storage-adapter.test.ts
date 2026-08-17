import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BabylonSlateFolderPort,
  FolderIdentity,
} from "./babylon-slate-folder-port";

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

const { ScopedStorageAdapter } = await import("./scoped-storage-adapter");

function createFakeFolderPort() {
  const files = new Map<string, string>();
  let folder: FolderIdentity = { id: "bookmark-1", name: "Repo" };
  let stale = false;
  const pickFolder = vi.fn(async () => {
    stale = false;
    return { folder };
  });
  const port: BabylonSlateFolderPort = {
    pickFolder,
    resolveFolder: vi.fn(async () => {
      if (stale) throw { code: "STALE_BOOKMARK" };
      return { folder };
    }),
    releaseFolder: vi.fn(async () => {}),
    readFile: vi.fn(async ({ path }) => {
      const value = files.get(path);
      if (value === undefined) throw new Error("missing");
      return { data: value };
    }),
    writeFile: vi.fn(async ({ path, data }) => {
      files.set(path, data);
    }),
    exists: vi.fn(async ({ path }) => ({ exists: files.has(path) })),
    readdir: vi.fn(async ({ path }) => ({
      entries: [...files.keys()]
        .filter((name) => name.startsWith(path ? `${path}/` : ""))
        .map((name) => ({
          name: name.slice(path ? path.length + 1 : 0),
          isDir: false,
          size: files.get(name)!.length,
          mtime: 1,
        })),
    })),
    mkdir: vi.fn(async () => {}),
    deleteFile: vi.fn(async ({ path }) => {
      files.delete(path);
    }),
    rmdir: vi.fn(async () => {}),
    stat: vi.fn(async ({ path }) => {
      if (!files.has(path)) throw new Error("missing");
      return { type: "file", size: files.get(path)!.length, mtime: 1 };
    }),
  };
  return {
    port,
    pickFolder,
    setFolder(next: FolderIdentity) {
      folder = next;
    },
    setStale(value: boolean) {
      stale = value;
    },
  };
}

describe("external tier (first-party folder port)", () => {
  beforeEach(() => {
    prefs.clear();
  });

  it("binds a folder through the picker and persists the bookmark", async () => {
    const fake = createFakeFolderPort();
    const adapter = new ScopedStorageAdapter(fake.port);

    await expect(adapter.pickProjectFolder()).resolves.toEqual({
      id: "bookmark-1",
      name: "Repo",
      tier: "external",
    });
    expect(prefs.get("babylonslate:scoped-folder")).toContain("bookmark-1");
  });

  it("resolves the persisted bookmark on cold launch without opening a picker", async () => {
    const fake = createFakeFolderPort();
    await new ScopedStorageAdapter(fake.port).pickProjectFolder();

    const next = new ScopedStorageAdapter(fake.port);
    await next.init();

    expect(fake.port.resolveFolder).toHaveBeenCalledWith({
      bookmark: "bookmark-1",
    });
    expect(fake.pickFolder).toHaveBeenCalledTimes(1);
    expect(next.getCurrentFolder()?.id).toBe("bookmark-1");
  });

  it("reopens a listed external project by resolving its bookmark", async () => {
    const fake = createFakeFolderPort();
    const adapter = new ScopedStorageAdapter(fake.port);
    const handle = await adapter.pickProjectFolder();
    fake.pickFolder.mockClear();

    await expect(adapter.openKnownFolder(handle)).resolves.toEqual(handle);
    expect(fake.port.resolveFolder).toHaveBeenCalledWith({
      bookmark: "bookmark-1",
    });
    expect(fake.pickFolder).not.toHaveBeenCalled();
  });

  it("persists a refreshed identity returned by resolve", async () => {
    const fake = createFakeFolderPort();
    await new ScopedStorageAdapter(fake.port).pickProjectFolder();
    fake.setFolder({ id: "bookmark-refreshed", name: "Repo renamed" });

    const next = new ScopedStorageAdapter(fake.port);
    await next.init();

    expect(next.getCurrentFolder()?.id).toBe("bookmark-refreshed");
    expect(prefs.get("babylonslate:scoped-folder")).toContain(
      "bookmark-refreshed",
    );
  });

  it("surfaces stale resolution as needsReconnect and reconnects through the picker", async () => {
    const fake = createFakeFolderPort();
    const adapter = new ScopedStorageAdapter(fake.port);
    const handle = await adapter.pickProjectFolder();
    fake.setStale(true);

    await expect(adapter.openKnownFolder(handle)).rejects.toThrow(
      /reconnect required/,
    );
    expect(await adapter.needsReconnect()).toBe(true);

    const reconnected = await adapter.reconnectFolder();
    expect(reconnected.id).toBe("bookmark-1");
    expect(await adapter.needsReconnect()).toBe(false);
    expect(fake.pickFolder).toHaveBeenCalledTimes(2);
  });

  it("round-trips text and binary through the injected coordinated-I/O port", async () => {
    const fake = createFakeFolderPort();
    const adapter = new ScopedStorageAdapter(fake.port);
    await adapter.pickProjectFolder();

    await adapter.writeText("project.json", "{}");
    expect(await adapter.readText("project.json")).toBe("{}");
    await adapter.writeBinary("blob.bin", new Uint8Array([1, 2]));
    expect(await adapter.readBinary("blob.bin")).toEqual(
      new Uint8Array([1, 2]),
    );
    expect(fake.port.writeFile).toHaveBeenCalledWith({
      path: "blob.bin",
      data: "AQI=",
      encoding: "base64",
    });
  });

  it("delegates directory, stat, and delete operations", async () => {
    const fake = createFakeFolderPort();
    const adapter = new ScopedStorageAdapter(fake.port);
    await adapter.pickProjectFolder();
    await adapter.writeText("project.json", "{}");

    expect(await adapter.exists("project.json")).toBe(true);
    expect(await adapter.readdir("")).toEqual([
      { name: "project.json", isDir: false, size: 2, mtime: 1 },
    ]);
    expect(await adapter.stat("project.json")).toEqual({
      isDir: false,
      size: 2,
      mtime: 1,
    });
    await adapter.remove("project.json");
    expect(await adapter.exists("project.json")).toBe(false);
  });

  it("refuses tiers it does not own and releases native scope", async () => {
    const fake = createFakeFolderPort();
    const adapter = new ScopedStorageAdapter(fake.port);
    await expect(
      adapter.openKnownFolder({ id: "x", name: "x", tier: "documents" }),
    ).rejects.toThrow(/cannot open tier/);
    await expect(adapter.openDocumentsProject("x")).rejects.toThrow(
      /DocumentsStorageAdapter/,
    );

    await adapter.pickProjectFolder();
    await adapter.releaseFolder();
    expect(fake.port.releaseFolder).toHaveBeenCalled();
    expect(adapter.getCurrentFolder()).toBeNull();
  });
});
