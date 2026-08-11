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

describe("web storage adapter", () => {
  afterEach(() => {
    vi.mocked(isTestModeEnabled).mockReturnValue(false);
    localStorage.clear();
  });

  it("writes and reads project files", async () => {
    const storage = new WebStorageAdapter();
    await storage.pickProjectFolder();
    await storage.writeText("project.json", '{"name":"test"}');
    const content = await storage.readText("project.json");
    expect(content).toBe('{"name":"test"}');
  });

  it("createStorage returns web adapter on web platform", () => {
    const storage = createStorage();
    expect(storage).toBeInstanceOf(WebStorageAdapter);
  });

  it("uses fixed project name when test mode is enabled", async () => {
    vi.mocked(isTestModeEnabled).mockReturnValue(true);
    const storage = new WebStorageAdapter();
    const folder = await storage.pickProjectFolder();
    expect(folder.name).toBe(TEST_PROJECT_NAME);
  });
});
