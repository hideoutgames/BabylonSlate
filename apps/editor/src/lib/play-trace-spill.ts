import type { ProjectStorage, DocumentRef } from "@babylonslate/core";
import { createDocumentRef } from "@babylonslate/core";
import { writeTraceDocument } from "@babylonslate/assets";
import type { TracePayload } from "@babylonslate/debugger";
import type { PlaySessionResult } from "../services/play-session";

export function recordedTraceFileName(nowMs: number): string {
  return `session-${nowMs}`;
}

export async function spillRecordedTraceDocument(options: {
  derivedStorage: ProjectStorage;
  projectGuid: string;
  payload: TracePayload;
  fileName: string;
  documentGuid: string;
}): Promise<{ path: string; ref: DocumentRef }> {
  const path = await writeTraceDocument(
    options.derivedStorage,
    options.projectGuid,
    options.fileName,
    {
      name: options.fileName,
      guid: options.documentGuid,
      payload: options.payload as unknown as Record<string, unknown>,
    },
  );
  return {
    path,
    ref: createDocumentRef("trace", path),
  };
}

/** Finalize an in-flight recorder, with a bounded wait if its Worker is unavailable. */
export async function finishPlaySessionWithTrace(options: {
  executeConsoleCommand: (line: string) => Promise<unknown>;
  stop: () => PlaySessionResult;
}): Promise<PlaySessionResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      options.executeConsoleCommand("snapshot stop"),
      new Promise<void>((resolve) => { timeout = setTimeout(resolve, 2_000); }),
    ]);
  } catch {
    // Worker may already be gone; in-process `stop()` still finalizes.
  } finally {
    clearTimeout(timeout);
  }
  return options.stop();
}
