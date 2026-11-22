import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectFolderHandle } from "@haptic/core";
import type { BlobReclaimResult } from "../services/project-service";
import { automaticBlobSweepAllowed, scheduleAutomaticBlobSweep } from "./automatic-blob-sweep";

const documents: ProjectFolderHandle = { id: "documents:Game", name: "Game", tier: "documents" };
const opfs: ProjectFolderHandle = { id: "opfs:Game", name: "Game", tier: "opfs" };
const external: ProjectFolderHandle = { id: "scoped:abc", name: "Game", tier: "external" };
const desktop: ProjectFolderHandle = { id: "node:/Users/me/Projects/Game", name: "Game", tier: "documents" };

afterEach(() => {
  vi.useRealTimers();
});

describe("automaticBlobSweepAllowed", () => {
  it.each([
    ["iPad app storage", "ios", documents, false, true],
    ["Android app storage", "android", documents, false, true],
    ["a chosen iPad folder other apps share", "ios", external, false, false],
    ["a web tab holding the project's session lock", "web", opfs, true, true],
    ["a web tab that cannot take Web Locks", "web", opfs, false, false],
    ["desktop, where two windows may open one project", "electron", desktop, true, false],
    ["no open folder", "ios", null, false, false],
  ] as const)("on %s: %s", (_name, platform, folder, webLocks, allowed) => {
    expect(automaticBlobSweepAllowed(platform, folder, webLocks)).toBe(allowed);
  });
});

describe("scheduleAutomaticBlobSweep", () => {
  const stopped: BlobReclaimResult = { status: "reclaimed", files: 0, bytes: 0, stopped: true };
  const finished: BlobReclaimResult = { status: "reclaimed", files: 2, bytes: 10, stopped: false };

  it("runs once after the delay, tries again while runs stop, and never after it is cancelled", async () => {
    vi.useFakeTimers();
    const reclaimUnusedBlobs = vi.fn<(options: { automatic?: boolean }) => Promise<BlobReclaimResult>>()
      .mockResolvedValueOnce(stopped)
      .mockResolvedValueOnce(finished);
    const service = { guid: "g", reclaimUnusedBlobs };
    const cancel = scheduleAutomaticBlobSweep(service, { delayMs: 1_000, retryMs: 5_000, retries: 3 });
    await vi.advanceTimersByTimeAsync(999);
    expect(reclaimUnusedBlobs).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reclaimUnusedBlobs).toHaveBeenCalledWith(expect.objectContaining({ automatic: true }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reclaimUnusedBlobs).toHaveBeenCalledTimes(2);
    // Finished: no further run.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reclaimUnusedBlobs).toHaveBeenCalledTimes(2);
    cancel();

    const later = vi.fn(async () => finished);
    const cancelLater = scheduleAutomaticBlobSweep({ guid: "g", reclaimUnusedBlobs: later }, { delayMs: 1_000 });
    cancelLater();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(later).not.toHaveBeenCalled();
  });

  it("stops retrying after its limit", async () => {
    vi.useFakeTimers();
    const reclaimUnusedBlobs = vi.fn(async () => stopped);
    scheduleAutomaticBlobSweep({ guid: "g", reclaimUnusedBlobs }, { delayMs: 0, retryMs: 1_000, retries: 2 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reclaimUnusedBlobs).toHaveBeenCalledTimes(3);
  });
});
