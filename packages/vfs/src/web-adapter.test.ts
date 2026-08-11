import { describe, expect, it, vi, afterEach } from "vitest";
import { createStorage } from "./create-storage";
import { TEST_PROJECT_NAME } from "./test-mode";
import { WebStorageAdapter } from "./web-adapter";

vi.mock("./test-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./test-mode")>();
  return {
    ...actual,
    isTestModeEnabled: vi.fn(() => false),
  };
});

import { isTestModeEnabled } from "./test-mode";

async function openedAdapter() {
  const storage = new WebStorageAdapter();
  await storage.pickProjectFolder();
  return storage;
}

describe("web storage adapter", () => {
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

  it("createStorage returns web adapter on web platform", () => {
    expect(createStorage()).toBeInstanceOf(WebStorageAdapter);
  });

  it("uses fixed project name when test mode is enabled", async () => {
    vi.mocked(isTestModeEnabled).mockReturnValue(true);
    const storage = new WebStorageAdapter();
    expect((await storage.pickProjectFolder()).name).toBe(TEST_PROJECT_NAME);
  });

  it("prompts for a folder name outside test mode", async () => {
    vi.stubGlobal("prompt", vi.fn(() => "Named.babylonslate"));
    const storage = new WebStorageAdapter();
    const folder = await storage.pickProjectFolder();
    expect(folder.name).toBe("Named.babylonslate");
    expect(folder.id).toBe("web:Named.babylonslate");
  });

  it("falls back to a default name when the prompt is dismissed", async () => {
    vi.stubGlobal("prompt", vi.fn(() => null));
    const storage = new WebStorageAdapter();
    expect((await storage.pickProjectFolder()).name).toBe("MyGame.babylonslate");
  });

  it("has no current folder until one is picked", async () => {
    const storage = new WebStorageAdapter();
    expect(storage.getCurrentFolder()).toBeNull();
    await storage.pickProjectFolder();
    expect(storage.getCurrentFolder()).not.toBeNull();
  });

  it("rejects file operations before a folder is selected", async () => {
    const storage = new WebStorageAdapter();
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
        { name: "project.json", isDir: false },
        { name: "scenes", isDir: true },
      ]),
    );

    const scenes = await storage.readdir("scenes");
    expect(scenes).toEqual(
      expect.arrayContaining([
        { name: "main.scene.json", isDir: false },
        { name: "nested", isDir: true },
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

  it("creates a directory marker without clobbering an existing one", async () => {
    const storage = await openedAdapter();
    await storage.mkdir("assets");
    expect(await storage.exists("assets/.keep")).toBe(true);

    await storage.writeText("assets/.keep", "sentinel");
    await storage.mkdir("assets/");
    expect(await storage.readText("assets/.keep")).toBe("sentinel");
  });

  it("persists files across adapter instances", async () => {
    const storage = await openedAdapter();
    await storage.writeText("project.json", '{"persisted":true}');

    const reopened = new WebStorageAdapter();
    expect(reopened.getCurrentFolder()).not.toBeNull();
    expect(await reopened.readText("project.json")).toBe('{"persisted":true}');
  });
});
