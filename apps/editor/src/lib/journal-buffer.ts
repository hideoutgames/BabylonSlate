import {
  coalesceJournalLines,
  serializeJournalLine,
  type JournalLine,
} from "@babylonslate/edit";
import { attachLifecyclePause } from "../services/lifecycle-pause";

/**
 * Longest time an applied edit waits in memory before its journal record is
 * written. A crash inside this window loses at most these edits' recovery.
 */
export const JOURNAL_FLUSH_DELAY_MS = 150;

export type JournalWriter = (
  projectGuid: string,
  lines: string[],
) => Promise<void>;

/**
 * Batches recovery-journal records per project. Consecutive records of one
 * gesture (same document, merge key and target) fold into one record, and a
 * flush writes every buffered record in one append. Writes for a project run
 * in order, so awaiting `flush` also awaits every earlier write.
 */
export class JournalBuffer {
  private readonly pending = new Map<string, JournalLine[]>();
  private readonly writes = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly write: JournalWriter;
  private readonly delayMs: number;
  private readonly onError: (error: unknown) => void;

  constructor(
    write: JournalWriter,
    options: { delayMs?: number; onError?: (error: unknown) => void } = {},
  ) {
    this.write = write;
    this.delayMs = options.delayMs ?? JOURNAL_FLUSH_DELAY_MS;
    this.onError =
      options.onError ??
      ((error) => console.error("[journal] failed to append edits", error));
  }

  append(projectGuid: string, line: JournalLine): void {
    const lines = this.pending.get(projectGuid) ?? [];
    const last = lines.at(-1);
    const folded = last ? coalesceJournalLines(last, line) : null;
    if (folded) lines[lines.length - 1] = folded;
    else lines.push(line);
    this.pending.set(projectGuid, lines);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** Write buffered records (all projects, or one) and wait for earlier writes. Never rejects. */
  flush(projectGuid?: string): Promise<void> {
    const guids =
      projectGuid === undefined
        ? [...new Set([...this.pending.keys(), ...this.writes.keys()])]
        : [projectGuid];
    const waits = guids.map((guid) => {
      const lines = this.pending.get(guid);
      this.pending.delete(guid);
      const previous = this.writes.get(guid) ?? Promise.resolve();
      if (!lines?.length) return previous;
      const serialized = lines.map(serializeJournalLine);
      const next = previous
        .then(() => this.write(guid, serialized))
        .catch(this.onError);
      this.writes.set(guid, next);
      void next.then(() => {
        if (this.writes.get(guid) === next) this.writes.delete(guid);
      });
      return next;
    });
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return Promise.all(waits).then(() => undefined);
  }

  /**
   * Run a journal read or clear for one project once every record buffered for
   * it has been written, so a replay sees the latest edits and no record
   * buffered before a Save, discard or close lands after its clear.
   */
  async afterFlush<T>(projectGuid: string, operation: () => Promise<T>): Promise<T> {
    await this.flush(projectGuid);
    return operation();
  }
}

/**
 * Write buffered records on `pagehide` and whenever the app is hidden or
 * backgrounded, so a reload, tab close or app switch does not wait out the
 * batching window. The returned detach flushes once more.
 */
export function attachJournalFlushOnHide(buffer: JournalBuffer): () => void {
  const flush = () => {
    void buffer.flush();
  };
  window.addEventListener("pagehide", flush);
  const detachPause = attachLifecyclePause((hidden) => {
    if (hidden) flush();
  });
  return () => {
    window.removeEventListener("pagehide", flush);
    detachPause();
    flush();
  };
}
