import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  appendJournalLine,
  readJournalLines,
  truncateJournal,
} from "./derived-data";

describe("derived-data journal", () => {
  it("preserves concurrently appended edits in invocation order", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("derived-root");
    await Promise.all([
      appendJournalLine(storage, "proj-1", "first"),
      appendJournalLine(storage, "proj-1", "second"),
    ]);
    expect(await readJournalLines(storage, "proj-1")).toEqual([
      "first",
      "second",
    ]);
  });

  it("keeps recovery when a save has become stale, and retains appends after a successful clear", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("derived-root");
    await appendJournalLine(storage, "proj-1", "unsaved");
    const cleared = await truncateJournal(storage, "proj-1", () => false);
    expect(await readJournalLines(storage, "proj-1")).toEqual(["unsaved"]);
    expect(cleared).toBe(false);
    await Promise.all([
      truncateJournal(storage, "proj-1", () => true),
      appendJournalLine(storage, "proj-1", "new edit"),
    ]);
    expect(await readJournalLines(storage, "proj-1")).toEqual(["new edit"]);
  });

  it("allows later edits to be journaled after a failed write", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("derived-root");
    vi.spyOn(storage, "writeText").mockRejectedValueOnce(
      new Error("storage unavailable"),
    );
    const writes = await Promise.allSettled([
      appendJournalLine(storage, "proj-1", "failed"),
      appendJournalLine(storage, "proj-1", "next edit"),
    ]);
    expect(writes.map((result) => result.status)).toEqual([
      "rejected",
      "fulfilled",
    ]);
    expect(await readJournalLines(storage, "proj-1")).toEqual(["next edit"]);
  });
  it("appends journal lines and reads them back in order", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("derived-root");

    await appendJournalLine(storage, "proj-1", '{"v":1,"line":1}');
    await appendJournalLine(storage, "proj-1", '{"v":1,"line":2}');

    expect(await readJournalLines(storage, "proj-1")).toEqual([
      '{"v":1,"line":1}',
      '{"v":1,"line":2}',
    ]);

    await truncateJournal(storage, "proj-1");
    expect(await readJournalLines(storage, "proj-1")).toEqual([]);
  });
});
