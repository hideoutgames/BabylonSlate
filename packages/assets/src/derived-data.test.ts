import { describe, expect, it } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  appendJournalLine,
  readJournalLines,
  truncateJournal,
} from "./derived-data";

describe("derived-data journal", () => {
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
