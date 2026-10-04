/** One transcript row: a command, its result, or a session log. */
export type DebugConsoleTranscriptEntry = {
  id: string;
  timestamp: number;
  text: string;
  severity: string;
  testId?: string;
};

/** Session log fed to the console. IDs increase throughout a session. */
export type DebugConsoleTranscriptLog = {
  id: number;
  timestamp: number;
  severity: string;
  message: string;
};

const logRows = new WeakMap<DebugConsoleTranscriptLog, DebugConsoleTranscriptEntry>();

/** The row for a log, reused while the same log object is passed in. */
export function transcriptEntryForLog(
  log: DebugConsoleTranscriptLog,
): DebugConsoleTranscriptEntry {
  let row = logRows.get(log);
  if (!row) {
    row = {
      id: `log-${log.id}`,
      timestamp: log.timestamp,
      text: `[${log.severity}] ${log.message}`,
      severity: log.severity,
      testId: `debug-console-log-${log.id}`,
    };
    logRows.set(log, row);
  }
  return row;
}

/** Index of the first log with an id above `clearedLogId` (ids increase). */
function firstLogAfter(
  logs: readonly DebugConsoleTranscriptLog[],
  clearedLogId: number,
): number {
  let low = 0;
  let high = logs.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (logs[middle]!.id > clearedLogId) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * The newest `limit` rows of the console's own entries and the logs after
 * `clearedLogId`, in timestamp order. Both streams are already in timestamp
 * order, so this merges their tails instead of sorting everything; at equal
 * timestamps the console's entries come first.
 */
export function mergeDebugConsoleTranscript(
  entries: readonly DebugConsoleTranscriptEntry[],
  logs: readonly DebugConsoleTranscriptLog[],
  clearedLogId: number,
  limit: number,
): DebugConsoleTranscriptEntry[] {
  const firstLog = firstLogAfter(logs, clearedLogId);
  const newestFirst: DebugConsoleTranscriptEntry[] = [];
  let entry = entries.length - 1;
  let log = logs.length - 1;
  while (newestFirst.length < limit && (entry >= 0 || log >= firstLog)) {
    if (
      log >= firstLog &&
      (entry < 0 || logs[log]!.timestamp >= entries[entry]!.timestamp)
    ) {
      newestFirst.push(transcriptEntryForLog(logs[log]!));
      log -= 1;
    } else {
      newestFirst.push(entries[entry]!);
      entry -= 1;
    }
  }
  return newestFirst.reverse();
}
