import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@babylonslate/vfs";
import {
  appendJournalLines,
  readJournalLines,
  truncateJournal,
} from "@babylonslate/assets";
import {
  commandToJournalPayload,
  EditSession,
  replayJournalLines,
  SetAssetDocumentCommand,
  type EditCommand,
} from "@babylonslate/edit";
import { JOURNAL_FLUSH_DELAY_MS, JournalBuffer } from "./journal-buffer";

const guid = "proj-1";
const docId = "water:assets/Lake.water.babasset";

async function derivedStorage() {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("derived-root");
  return storage;
}

function record(command: EditCommand<unknown>) {
  return {
    v: 1 as const,
    docId,
    at: "2026-09-28T10:00:00Z",
    command: commandToJournalPayload(command),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("JournalBuffer", () => {
  it("journals a scrub as one record on its own, and recovery restores the final value", async () => {
    vi.useFakeTimers();
    const storage = await derivedStorage();
    const buffer = new JournalBuffer((project, lines) =>
      appendJournalLines(storage, project, lines),
    );
    const session = new EditSession();
    const initial: Record<string, unknown> = { waveHeight: 1, opacity: 0.8 };
    let doc = initial;
    for (const waveHeight of [1.2, 1.4, 1.6, 1.8, 2]) {
      const command = new SetAssetDocumentCommand(doc, { ...doc, waveHeight }, "water:waveHeight");
      doc = session.apply(docId, doc, command).doc;
      buffer.append(guid, record(command));
    }

    await vi.advanceTimersByTimeAsync(JOURNAL_FLUSH_DELAY_MS);
    await buffer.flush();
    const lines = await readJournalLines(storage, guid);
    expect(lines).toHaveLength(1);
    const { documents } = replayJournalLines(lines, new Map([[docId, initial]]));
    expect(documents.get(docId)).toEqual({ waveHeight: 2, opacity: 0.8 });
  });

  it("writes buffered records before a Save's clear, so no stale record lands afterwards", async () => {
    vi.useFakeTimers();
    const storage = await derivedStorage();
    const buffer = new JournalBuffer((project, lines) =>
      appendJournalLines(storage, project, lines),
    );
    buffer.append(guid, record(new SetAssetDocumentCommand({ opacity: 1 }, { opacity: 0.5 })));

    await buffer.flush(guid);
    expect(await readJournalLines(storage, guid)).toHaveLength(1);
    expect(await truncateJournal(storage, guid)).toBe(true);
    await vi.advanceTimersByTimeAsync(JOURNAL_FLUSH_DELAY_MS * 2);
    await buffer.flush();
    expect(await readJournalLines(storage, guid)).toEqual([]);
  });

  it("reports a failed write and still journals later edits", async () => {
    const storage = await derivedStorage();
    const onError = vi.fn();
    const write = vi
      .fn((project: string, lines: string[]) => appendJournalLines(storage, project, lines))
      .mockRejectedValueOnce(new Error("storage unavailable"));
    const buffer = new JournalBuffer(write, { onError });
    buffer.append(guid, record(new SetAssetDocumentCommand({ opacity: 1 }, { opacity: 0.5 })));
    await expect(buffer.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();

    buffer.append(guid, record(new SetAssetDocumentCommand({ opacity: 0.5 }, { opacity: 0.2 })));
    await buffer.flush(guid);
    const { documents } = replayJournalLines(
      await readJournalLines(storage, guid),
      new Map([[docId, { opacity: 1 }]]),
    );
    expect(documents.get(docId)).toEqual({ opacity: 0.2 });
  });
});
