import { describe, expect, it } from "vitest";
import {
  mergeDebugConsoleTranscript,
  type DebugConsoleTranscriptEntry,
  type DebugConsoleTranscriptLog,
} from "./debug-console-transcript";

function command(id: string, timestamp: number): DebugConsoleTranscriptEntry {
  return { id, timestamp, text: `> ${id}`, severity: "command" };
}

function log(id: number, timestamp: number): DebugConsoleTranscriptLog {
  return { id, timestamp, severity: "info", message: `message ${id}` };
}

const entries = [command("command-0", 10), command("result-0", 20), command("command-1", 30)];
const logs = [log(1, 5), log(2, 10), log(3, 20), log(4, 20), log(5, 40)];

const ids = (rows: readonly DebugConsoleTranscriptEntry[]) => rows.map((row) => row.id);

describe("mergeDebugConsoleTranscript", () => {
  it("orders commands and logs by time, with commands first at equal times", () => {
    expect(ids(mergeDebugConsoleTranscript(entries, logs, -Infinity, 500))).toEqual([
      "log-1",
      "command-0",
      "log-2",
      "result-0",
      "log-3",
      "log-4",
      "command-1",
      "log-5",
    ]);
  });

  it("keeps only the newest rows, even when the cut falls inside equal times", () => {
    expect(ids(mergeDebugConsoleTranscript(entries, logs, -Infinity, 5))).toEqual([
      "result-0",
      "log-3",
      "log-4",
      "command-1",
      "log-5",
    ]);
    expect(ids(mergeDebugConsoleTranscript(entries, logs, -Infinity, 4))).toEqual([
      "log-3",
      "log-4",
      "command-1",
      "log-5",
    ]);
  });

  it("hides logs up to the cleared id while keeping later logs", () => {
    expect(ids(mergeDebugConsoleTranscript([], logs, 3, 500))).toEqual(["log-4", "log-5"]);
    expect(ids(mergeDebugConsoleTranscript(entries, logs, 3, 500))).toEqual([
      "command-0",
      "result-0",
      "log-4",
      "command-1",
      "log-5",
    ]);
    expect(mergeDebugConsoleTranscript([], logs, 5, 500)).toEqual([]);
  });

  it("formats a log row once and reuses it while the same log is passed again", () => {
    const first = mergeDebugConsoleTranscript([], logs, -Infinity, 500);
    expect(first[1]).toEqual({
      id: "log-2",
      timestamp: 10,
      text: "[info] message 2",
      severity: "info",
      testId: "debug-console-log-2",
    });
    const next = mergeDebugConsoleTranscript([], [...logs, log(6, 50)], -Infinity, 500);
    expect(next.slice(0, logs.length)).toEqual(first);
    next.slice(0, logs.length).forEach((row, index) => expect(row).toBe(first[index]));
  });
});
