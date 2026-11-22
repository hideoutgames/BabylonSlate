import type { ProjectFolderHandle } from "@haptic/core";
import type { HostPlatform } from "@haptic/vfs";
import type { ProjectService } from "../services/project-service";

/** How long after a project opens the first automatic run starts, clear of the open's own reads and loads. */
export const AUTOMATIC_BLOB_SWEEP_DELAY_MS = 15_000;
/** A run that stopped (a write landed, writes were busy) tries again this much later, at most this many times. */
export const AUTOMATIC_BLOB_SWEEP_RETRY_MS = 30_000;
export const AUTOMATIC_BLOB_SWEEP_RETRIES = 3;

/**
 * Whether Clean Unused Project Storage may run on its own: only where the
 * host guarantees this editor is the project's one writer, since another
 * writer's saves are invisible to the write-admission lock and the grace
 * window alone cannot protect a blob it reuses. iPad and Android app storage
 * (one app process), and a web tab holding the project's session lock (Web
 * Locks: one tab per project). Never desktop, where two windows may open one
 * project, nor a folder chosen outside app storage, which other apps share.
 */
export function automaticBlobSweepAllowed(platform: HostPlatform, folder: ProjectFolderHandle | null, webLocks: boolean): boolean {
  if (!folder) return false;
  if (platform === "ios" || platform === "android") return folder.tier === "documents";
  if (platform === "web") return folder.tier === "opfs" && webLocks;
  return false;
}

/**
 * Runs `reclaimUnusedBlobs({ automatic: true })` once, `delayMs` after the
 * project opened, off the open's critical path, and again later when a run
 * stopped. Returns the cancel the project's close calls. Failures are only
 * logged: the next open tries again.
 */
export function scheduleAutomaticBlobSweep(
  projectService: Pick<ProjectService, "reclaimUnusedBlobs" | "guid">,
  options: { delayMs?: number; retryMs?: number; retries?: number } = {},
): () => void {
  const guid = projectService.guid;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let left = options.retries ?? AUTOMATIC_BLOB_SWEEP_RETRIES;
  const attempt = async () => {
    timer = null;
    if (controller.signal.aborted || projectService.guid !== guid) return;
    try {
      const result = await projectService.reclaimUnusedBlobs({ automatic: true, signal: controller.signal });
      if (result.status === "reclaimed" && result.stopped && left-- > 0 && !controller.signal.aborted) {
        timer = setTimeout(() => void attempt(), options.retryMs ?? AUTOMATIC_BLOB_SWEEP_RETRY_MS);
      }
    } catch (error) {
      if (!controller.signal.aborted) console.warn("[editor] Could not clean unused project storage", error);
    }
  };
  timer = setTimeout(() => void attempt(), options.delayMs ?? AUTOMATIC_BLOB_SWEEP_DELAY_MS);
  return () => {
    controller.abort();
    if (timer !== null) clearTimeout(timer);
  };
}
