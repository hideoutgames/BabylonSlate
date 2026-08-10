import { describe, expect, it } from "vitest";
import { createStorage } from "./create-storage";
import { WebStorageAdapter } from "./web-adapter";

describe("web storage adapter", () => {
  it("writes and reads project files", async () => {
    localStorage.clear();
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
});
