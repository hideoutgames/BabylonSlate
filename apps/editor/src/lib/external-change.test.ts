import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  readProjectJsonMtime,
  refreshMtimeSnapshotAfterEditorSave,
} from "./external-change";

describe("readProjectJsonMtime", () => {
  it("returns the project.json mtime when the file exists", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("demo.babproject");
    await storage.writeText("project.json", "{}");
    const mtime = await readProjectJsonMtime(storage);
    expect(mtime).toBe((await storage.stat("project.json")).mtime);
  });

  it("returns null when project.json is missing", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("demo.babproject");
    expect(await readProjectJsonMtime(storage)).toBeNull();
  });

  it("recaptures the mtime snapshot after an editor save", async () => {
    const capture = vi.fn(async () => {});
    await refreshMtimeSnapshotAfterEditorSave(capture);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
