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
    expect((await storage.pickProjectFolder()).name).toBe("MyGame.babproject");
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
});
