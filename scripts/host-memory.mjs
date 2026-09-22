import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { freemem, totalmem } from "node:os";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
export function positiveReading(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Zero constrainedMemory means unavailable, not zero or unbounded capacity. */
export async function observeHostMemory(options = {}) {
  const errors = [];
  const observe = (name, read) => {
    try {
      return positiveReading(read?.());
    } catch {
      errors.push(`${name}: observation failed`);
      return null;
    }
  };
  const totalBytes = observe("total memory", options.totalmem ?? totalmem);
  const availableBytes = observe(
    "available memory",
    options.availableMemory ?? (() => process.availableMemory?.() ?? freemem()),
  );
  const constrainedBytes = observe(
    "effective constraint",
    options.constrainedMemory ?? (() => process.constrainedMemory?.()),
  );
  let windows = {};
  if ((options.platform ?? process.platform) === "win32") {
    try {
      windows = await (
        options.windowsProbe ??
        (async () => {
          const { stdout } = await execute(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-File",
              fileURLToPath(new URL("./windows-memory.ps1", import.meta.url)),
            ],
            { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024 },
          );
          return JSON.parse(stdout.replace(/^\uFEFF/, ""));
        })
      )();
      for (const key of [
        "totalBytes",
        "availableBytes",
        "systemCommitLimitBytes",
        "systemCommitAvailableBytes",
      ]) {
        if (!Number.isFinite(windows[key]) || windows[key] < 0)
          throw new Error("invalid reading");
      }
    } catch {
      windows = {};
      errors.push("Windows physical/system commit probe unavailable");
    }
  }
  const total = positiveReading(windows.totalBytes) ?? totalBytes;
  const available = Number.isFinite(windows.availableBytes)
    ? Math.min(windows.availableBytes, availableBytes ?? Infinity)
    : availableBytes;
  if (available === null) errors.push("Available memory is unknown");
  return {
    totalBytes: total,
    availableBytes: available,
    constrainedBytes,
    effectiveLimitBytes:
      total === null
        ? constrainedBytes
        : Math.min(total, constrainedBytes ?? total),
    systemCommitLimitBytes: windows.systemCommitLimitBytes ?? null,
    systemCommitAvailableBytes: windows.systemCommitAvailableBytes ?? null,
    source: windows.source ?? "Node process/os APIs; commit unavailable",
    errors,
  };
}
