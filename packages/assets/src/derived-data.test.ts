import { describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  appendJournalLine,
  appendJournalLines,
  hasJournal,
  readJournalLines,
  truncateJournal,
} from "./derived-data";

/** A ~1 KiB journal record, numbered so order is checkable. */
function record(index: number): string {
  return JSON.stringify({ v: 1, line: index, pad: "x".repeat(1000) });
}

describe("derived-data journal", () => {
  it("keeps a long session complete and in order while each append rewrites a bounded tail", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("derived-root");
    const writes = vi.spyOn(storage, "writeText");
    const expected: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      expected.push(record(index));
      await appendJournalLine(storage, "proj-1", record(index));
    }
    const batch = Array.from({ length: 150 }, (_, offset) => record(300 + offset));
    expected.push(...batch);
    await appendJournalLines(storage, "proj-1", batch);

    expect(await readJournalLines(storage, "proj-1")).toEqual(expected);
    // ~450 KiB journalled: no single write may approach the whole journal.
    const largest = Math.max(...writes.mock.calls.map(([, text]) => text.length));
    expect(largest).toBeLessThan(100_000);
  });

  it("writes each record larger than a segment once, never reading or rewriting an earlier one", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("derived-root");
    const reads = vi.spyOn(storage, "readText");
    const writes = vi.spyOn(storage, "writeText");
    // Full-document asset records (e.g. a large Material) exceed the 64 KiB bound.
    const large = (index: number) =>
      JSON.stringify({ v: 1, line: index, pad: "x".repeat(70_000) });
    const expected = [0, 1, 2, 3].map(large);
    for (const line of expected) {
      await appendJournalLine(storage, "proj-1", line);
    }

    const written = writes.mock.calls.reduce((sum, [, text]) => sum + text.length, 0);
    expect(written).toBe(expected.reduce((sum, line) => sum + line.length + 1, 0));
    expect(reads).not.toHaveBeenCalled();
    expect(await readJournalLines(storage, "proj-1")).toEqual(expected);
  });

  it("recovers a single-file journal from an older session ahead of newer edits, and clears both layouts", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("derived-root");
    await storage.mkdir("derived/proj-1", true);
    await storage.writeText("derived/proj-1/journal.jsonl", "older-1\nolder-2\n");
    expect(await hasJournal(storage, "proj-1")).toBe(true);

    await appendJournalLine(storage, "proj-1", "newer");
    expect(await readJournalLines(storage, "proj-1")).toEqual([
      "older-1",
      "older-2",
      "newer",
    ]);

    expect(await truncateJournal(storage, "proj-1")).toBe(true);
    expect(await hasJournal(storage, "proj-1")).toBe(false);
    expect(await readJournalLines(storage, "proj-1")).toEqual([]);
    await appendJournalLine(storage, "proj-1", "after save");
    expect(await readJournalLines(storage, "proj-1")).toEqual(["after save"]);
  });

  it("clears a journal that spans several segments", async () => {
    const storage = new MemoryStorageAdapter("documents");
    await storage.openDocumentsProject("derived-root");
    await appendJournalLines(
      storage,
      "proj-1",
      Array.from({ length: 200 }, (_, index) => record(index)),
    );
    await truncateJournal(storage, "proj-1");
    expect(await hasJournal(storage, "proj-1")).toBe(false);
    await appendJournalLine(storage, "proj-1", "next");
    expect(await readJournalLines(storage, "proj-1")).toEqual(["next"]);
  });

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
