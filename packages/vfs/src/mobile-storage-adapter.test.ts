import { beforeEach, describe, expect, it, vi } from "vitest";
import { Preferences } from "@capacitor/preferences";
import { BabylonSlateScopedStorage } from "./capacitor-scoped-storage";
import { DocumentsStorageAdapter } from "./documents-adapter";
import { MobileStorageAdapter } from "./mobile-storage-adapter";
import { createFakeDocumentsFs } from "./test-support/fake-documents-fs";

const prefs = new Map<string, string>();
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => { prefs.set(key, value); }),
    remove: vi.fn(async ({ key }: { key: string }) => { prefs.delete(key); }),
  },
}));
vi.mock("./capacitor-scoped-storage", async (importOriginal) => ({
  ...await importOriginal<typeof import("./capacitor-scoped-storage")>(),
  BabylonSlateScopedStorage: { openFolder: vi.fn(), readFile: vi.fn() },
}));

describe("mobile project binding", () => {
  beforeEach(() => {
    prefs.clear();
    vi.clearAllMocks();
  });

  it("waits for persisted scope before binding Documents and keeps audio writes there", async () => {
    let finishRead!: (value: { value: string }) => void;
    vi.mocked(Preferences.get).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    const fs = createFakeDocumentsFs();
    const storage = new MobileStorageAdapter(new DocumentsStorageAdapter(fs));
    const initializing = storage.init();
    const opening = storage.openDocumentsProject("New Game");
    await Promise.resolve();
    finishRead({ value: JSON.stringify({ id: "external-old", name: "Old Game" }) });
    await Promise.all([initializing, opening]);
    await storage.writeBinary("assets/music.wav", new Uint8Array([0, 128, 255]));
    expect(storage.getCurrentFolder()?.id).toBe("documents:New Game");
    expect(await storage.readBinary("assets/music.wav")).toEqual(new Uint8Array([0, 128, 255]));
    expect(fs.tree.has("BabylonSlate/projects/New Game/assets/music.wav")).toBe(true);
  });

  it("restores expired folder access for reconnect without an explicit init call", async () => {
    prefs.set("babylonslate:scoped-folder", JSON.stringify({ id: "external-old", name: "Old Game" }));
    prefs.set("babylonslate:scoped-stale", "1");
    const storage = new MobileStorageAdapter(new DocumentsStorageAdapter(createFakeDocumentsFs()));
    expect(await storage.needsReconnect()).toBe(true);
    expect((await storage.listProjects()).map((folder) => folder.id)).toContain("external-old");
    await expect(storage.writeText("project.json", "overwrite")).rejects.toThrow(/reconnect/i);
  });

  it("offers reconnect when opening a recent external folder fails from Documents", async () => {
    const storage = new MobileStorageAdapter(new DocumentsStorageAdapter(createFakeDocumentsFs()));
    await storage.openDocumentsProject("Local");
    vi.mocked(BabylonSlateScopedStorage.openFolder).mockRejectedValue({ code: "ACCESS_REVOKED" });
    await expect(storage.openKnownFolder({ id: "revoked", name: "Cloud", tier: "external" })).rejects.toEqual({ code: "ACCESS_REVOKED" });
    expect(await storage.needsReconnect()).toBe(true);
  });
});
