import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStorageAdapter } from "@haptic/vfs";
import {
  appendJournalLines,
  readJournalLines,
  truncateJournal,
} from "@haptic/assets";
import {
  commandToJournalPayload,
  EditSession,
  replayJournalLines,
  serializeJournalLine,
  SetAssetDocumentCommand,
  type EditCommand,
} from "@haptic/edit";
import {
  attachJournalFlushOnHide,
  JOURNAL_FLUSH_DELAY_MS,
  JournalBuffer,
  MAX_UNWRITTEN_JOURNAL_LINES,
} from "./journal-buffer";

const guid = "proj-1";
const docId = "water:assets/Lake.water.hasset";

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

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
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

  it("lets recovery read an edit still in the batching window", async () => {
    const storage = await derivedStorage();
    const buffer = new JournalBuffer(
      (project, lines) => appendJournalLines(storage, project, lines),
      { delayMs: 60_000 },
    );
    buffer.append(guid, record(new SetAssetDocumentCommand({ opacity: 1 }, { opacity: 0.5 })));

    const lines = await buffer.afterFlush(guid, () => readJournalLines(storage, guid));
    const { documents } = replayJournalLines(lines, new Map([[docId, { opacity: 1 }]]));
    expect(documents.get(docId)).toEqual({ opacity: 0.5 });
  });

  it("clears the journal (Save, discard, close) with no earlier edit landing after the clear", async () => {
    vi.useFakeTimers();
    const storage = await derivedStorage();
    const buffer = new JournalBuffer((project, lines) =>
      appendJournalLines(storage, project, lines),
    );
    buffer.append(guid, record(new SetAssetDocumentCommand({ opacity: 1 }, { opacity: 0.5 })));

    expect(await buffer.clearAfterFlush(guid, () => truncateJournal(storage, guid))).toBe(true);
    await vi.advanceTimersByTimeAsync(JOURNAL_FLUSH_DELAY_MS * 2);
    await buffer.flush();
    expect(await readJournalLines(storage, guid)).toEqual([]);
  });

  it("reports a failed write and retries its records ahead of later edits", async () => {
    const storage = await derivedStorage();
    const onError = vi.fn();
    const write = vi
      .fn((project: string, lines: string[]) => appendJournalLines(storage, project, lines))
      .mockRejectedValueOnce(new Error("storage unavailable"));
    const buffer = new JournalBuffer(write, { onError });
    const failed = record(new SetAssetDocumentCommand({ opacity: 1 }, { opacity: 0.5 }));
    buffer.append(guid, failed);
    await expect(buffer.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();

    const later = record(new SetAssetDocumentCommand({ opacity: 0.5 }, { opacity: 0.2 }));
    buffer.append(guid, later);
    await buffer.flush(guid);
    expect(await readJournalLines(storage, guid)).toEqual([failed, later].map(serializeJournalLine));
  });

  it("drops records a failed write kept when their journal is cleared", async () => {
    const storage = await derivedStorage();
    const write = vi
      .fn((project: string, lines: string[]) => appendJournalLines(storage, project, lines))
      .mockRejectedValueOnce(new Error("storage unavailable"));
    const buffer = new JournalBuffer(write, { onError: () => {} });
    buffer.append(guid, record(new SetAssetDocumentCommand({ opacity: 1 }, { opacity: 0.5 })));

    expect(await buffer.clearAfterFlush(guid, () => truncateJournal(storage, guid))).toBe(true);
    await buffer.flush(guid);
    expect(await readJournalLines(storage, guid)).toEqual([]);
  });

  it("retries only the records a rolling write did not store, so none is journaled twice", async () => {
    const storage = await derivedStorage();
    const writeText = storage.writeText.bind(storage);
    let segments = 0;
    // The first segment of the flush lands, the second fails once.
    vi.spyOn(storage, "writeText").mockImplementation(async (path, text) => {
      if (path.endsWith(".jsonl") && ++segments === 2) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      return writeText(path, text);
    });
    const buffer = new JournalBuffer((project, lines) => appendJournalLines(storage, project, lines), { onError: () => {} });
    // ~1 KiB records of distinct documents (never folded), enough for two 64 KiB segments.
    const records = Array.from({ length: 100 }, (_, index) => ({
      ...record(new SetAssetDocumentCommand({ pad: "" }, { pad: "x".repeat(900) })),
      docId: `water:assets/Lake${index}.water.hasset`,
    }));
    for (const line of records) buffer.append(guid, line);
    await buffer.flush(guid);
    expect(segments).toBe(2);
    await buffer.flush(guid);
    expect(await readJournalLines(storage, guid)).toEqual(records.map(serializeJournalLine));
  });

  it("pauses journaling after storage stays full, ignoring edits until resumed, and reports both", async () => {
    let calls = 0;
    const onPausedChange = vi.fn();
    const buffer = new JournalBuffer(async () => {
      calls += 1;
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    }, { onError: () => {}, onPausedChange });
    for (let attempt = 0; attempt < 3; attempt++) {
      buffer.append(guid, record(new SetAssetDocumentCommand({ opacity: attempt }, { opacity: attempt + 1 })));
      await buffer.flush(guid);
    }
    expect(onPausedChange.mock.calls).toEqual([[guid, true]]);
    expect(buffer.isPaused(guid)).toBe(true);
    buffer.append(guid, record(new SetAssetDocumentCommand({ opacity: 0 }, { opacity: 1 })));
    await buffer.flush(guid);
    // Nothing is held or written while paused.
    expect(calls).toBe(3);
    buffer.resume(guid);
    expect(onPausedChange.mock.calls).toEqual([[guid, true], [guid, false]]);
    buffer.append(guid, record(new SetAssetDocumentCommand({ opacity: 0 }, { opacity: 1 })));
    await buffer.flush(guid);
    expect(calls).toBe(4);
  });

  it("pauses journaling instead of holding more than its cap of failed records", async () => {
    const onPausedChange = vi.fn();
    const write = vi.fn(async () => { throw new Error("storage unavailable"); });
    const buffer = new JournalBuffer(write, { onError: () => {}, onPausedChange });
    for (let index = 0; index <= MAX_UNWRITTEN_JOURNAL_LINES; index++) {
      buffer.append(guid, { ...record(new SetAssetDocumentCommand({ opacity: 1 }, { opacity: 0.5 })), docId: `water:assets/L${index}.water.hasset` });
    }
    await buffer.flush(guid);
    expect(onPausedChange).toHaveBeenCalledWith(guid, true);
    await buffer.flush(guid);
    expect(write).toHaveBeenCalledOnce();
  });

  it("rejects a required recovery write so a file operation can stop before mutating", async () => {
    const onError = vi.fn();
    const buffer = new JournalBuffer(async () => { throw new Error("Recovery storage full"); }, { onError });
    buffer.append(guid, record(new SetAssetDocumentCommand({ opacity: 1 }, { opacity: 0.5 })));
    await expect(buffer.flush(guid, { rejectOnError: true })).rejects.toThrow("Recovery storage full");
    expect(onError).toHaveBeenCalledOnce();
  });

  it.each([
    ["the page unloads", () => window.dispatchEvent(new Event("pagehide"))],
    [
      "the app is hidden",
      () => {
        setVisibility("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      },
    ],
  ])("writes buffered records without waiting for the batch timer when %s", async (_when, hide) => {
    const storage = await derivedStorage();
    // A timer this long cannot fire during the test, so only the hide can write.
    const buffer = new JournalBuffer(
      (project, lines) => appendJournalLines(storage, project, lines),
      { delayMs: 60_000 },
    );
    const detach = attachJournalFlushOnHide(buffer);
    try {
      buffer.append(guid, record(new SetAssetDocumentCommand({ opacity: 1 }, { opacity: 0.5 })));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await readJournalLines(storage, guid)).toEqual([]);

      hide();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const { documents } = replayJournalLines(
        await readJournalLines(storage, guid),
        new Map([[docId, { opacity: 1 }]]),
      );
      expect(documents.get(docId)).toEqual({ opacity: 0.5 });
    } finally {
      detach();
    }
  });
});
