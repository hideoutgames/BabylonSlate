import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "./memory-adapter";

describe("memory storage adapter", () => {
  afterEach(async () => {
    /* each test creates its own adapter */
  });

  it("round-trips binary and text", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.openDocumentsProject("Demo.babproject");
    const bytes = new Uint8Array([1, 2, 3, 255]);
    await storage.writeBinary("assets/tex.bin", bytes);
    expect(await storage.readBinary("assets/tex.bin")).toEqual(bytes);
    await storage.writeText("project.json", '{"ok":true}');
    expect(await storage.readText("project.json")).toBe('{"ok":true}');
  });

  it("supports remove, stat, and listProjects", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("A.babproject");
    await storage.writeText("a.txt", "x");
    expect((await storage.stat("a.txt")).size).toBe(1);
    await storage.remove("a.txt");
    expect(await storage.exists("a.txt")).toBe(false);
    const listed = await storage.listProjects();
    expect(listed.some((p) => p.name === "A.babproject")).toBe(true);
  });

  it("releases the current folder", async () => {
    const storage = new MemoryStorageAdapter();
    await storage.pickProjectFolder("X.babproject");
    expect(storage.getCurrentFolder()).not.toBeNull();
    await storage.releaseFolder();
    expect(storage.getCurrentFolder()).toBeNull();
  });
});
