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
 * in order, so awaiting `flush` also awaits every earlier write. Records whose
 * write fails stay buffered, ahead of later records, until a flush writes them
 * or a clear removes the journal they belong to.
 */
export class JournalBuffer {
  private readonly pending = new Map<string, JournalLine[]>();
  /** Serialized records handed to a write that has not succeeded yet, oldest first. */
  private readonly unwritten = new Map<string, string[]>();
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

  /**
   * Write buffered records (all projects, or one), retrying records an earlier
   * write failed to store, and wait for earlier writes. Reports failures;
   * rejects only when requested by a transactional caller.
   */
  flush(projectGuid?: string, options?: { rejectOnError?: boolean }): Promise<void> {
    const guids =
      projectGuid === undefined
        ? [...new Set([...this.pending.keys(), ...this.unwritten.keys(), ...this.writes.keys()])]
        : [projectGuid];
    const waits = guids.map((guid) => {
      const lines = this.pending.get(guid);
      this.pending.delete(guid);
      if (lines?.length) {
        this.unwritten.set(guid, [...(this.unwritten.get(guid) ?? []), ...lines.map(serializeJournalLine)]);
      }
      if (!this.unwritten.get(guid)?.length) return this.writes.get(guid) ?? Promise.resolve();
      const write = this.enqueue(guid, () => this.writeUnwritten(guid));
      const reported = write.catch(this.onError);
      return options?.rejectOnError ? write : reported;
    });
    if (this.pending.size === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return Promise.all(waits).then(() => undefined);
  }

  /**
   * Run a journal read for one project once every record buffered for it has
   * been written, so a replay sees the latest edits.
   */
  async afterFlush<T>(projectGuid: string, operation: () => Promise<T>): Promise<T> {
    await this.flush(projectGuid);
    return operation();
  }

  /**
   * Clear one project's journal after every record buffered for it has been
   * written. `clear` runs in that project's write order, so no earlier record
   * lands after it. When it reports a clear, records whose write failed before
   * it are dropped with the journal instead of being retried into the cleared one.
   */
  clearAfterFlush(projectGuid: string, clear: () => Promise<boolean>): Promise<boolean> {
    void this.flush(projectGuid);
    return this.enqueue(projectGuid, async () => {
      const stale = this.unwritten.get(projectGuid)?.length ?? 0;
      const cleared = await clear();
      if (cleared && stale > 0) {
        // Only flushes ran meanwhile, and they append; keep what they added.
        const later = this.unwritten.get(projectGuid)?.slice(stale) ?? [];
        if (later.length) this.unwritten.set(projectGuid, later);
        else this.unwritten.delete(projectGuid);
      }
      return cleared;
    });
  }

  /** Run `operation` after the project's earlier writes and clears settle. */
  private enqueue<T>(projectGuid: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(projectGuid) ?? Promise.resolve();
    const run = previous.then(operation);
    const settled = run.then(() => undefined, () => undefined);
    this.writes.set(projectGuid, settled);
    void settled.then(() => {
      if (this.writes.get(projectGuid) === settled) this.writes.delete(projectGuid);
    });
    return run;
  }

  private async writeUnwritten(projectGuid: string): Promise<void> {
    const lines = this.unwritten.get(projectGuid);
    if (!lines?.length) return;
    this.unwritten.delete(projectGuid);
    try {
      await this.write(projectGuid, lines);
    } catch (error) {
      // Keep them ahead of records flushed since, so a later write keeps the order.
      this.unwritten.set(projectGuid, [...lines, ...(this.unwritten.get(projectGuid) ?? [])]);
      throw error;
    }
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
