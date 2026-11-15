import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { folderBoundStorage } from "./folder-bound-storage";

describe("folderBoundStorage", () => {
  it("reads and writes its folder only while that folder is bound", async () => {
    const storage = new MemoryStorageAdapter("documents");
    const a = await storage.openDocumentsProject("A");
    await storage.writeText("notes.txt", "A");
    const bound = folderBoundStorage(storage, a.id);
    await bound.writeText("notes.txt", "A2");
    expect(await bound.readText("notes.txt")).toBe("A2");
    expect(bound.getCurrentFolder()).toEqual(a);

    await storage.openDocumentsProject("B");
    await storage.writeText("notes.txt", "B");
    await expect(bound.writeText("notes.txt", "late")).rejects.toThrow("The project folder is no longer open.");
    await expect(bound.readText("notes.txt")).rejects.toThrow("The project folder is no longer open.");
    await expect(bound.remove("notes.txt")).rejects.toThrow("The project folder is no longer open.");
    expect(bound.getCurrentFolder()).toBeNull();
    expect(await storage.readText("notes.txt")).toBe("B");

    // A again: the view works again, for A only.
    await storage.openKnownFolder(a);
    expect(await bound.readText("notes.txt")).toBe("A2");
  });

  it("never changes the bound folder itself", async () => {
    const storage = new MemoryStorageAdapter("documents");
    const a = await storage.openDocumentsProject("A");
    const bound = folderBoundStorage(storage, a.id);
    await expect(bound.openDocumentsProject("B")).rejects.toThrow("cannot change its folder");
    await expect(bound.releaseFolder()).rejects.toThrow("cannot change its folder");
    expect(storage.getCurrentFolder()).toEqual(a);
  });
});
