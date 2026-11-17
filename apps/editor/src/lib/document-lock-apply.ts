import type { SourceControlService } from "../services/source-control-service";
import { assertWritableUnderLock } from "./locked-writes";

/** True when apply* should no-op; a session lock cannot be bypassed by Edit Anyway. */
export function isMutatingApplyBlocked(
  sourceControl: SourceControlService,
  path: string,
  pluginReadOnly: boolean,
  authoringReadOnly = false,
): boolean {
  if (authoringReadOnly || pluginReadOnly) return true;
  return sourceControl.isDocumentReadOnly(path);
}

/** Lock On Edit after a successful apply (lock, ask or nothing). Never throws; never blocks. */
export function afterMutatingApply(
  sourceControl: SourceControlService,
  path: string,
): Promise<void> {
  return sourceControl.onEdit(path);
}

/**
 * Texture Details' re-encode (Retry Encoding, or a Details change) rewrites the
 * Texture file: refused while someone else has locked it (Edit Anyway
 * included), and an accepted requeue counts as an edit for Lock On Edit.
 */
export async function requeueWithEditLock(
  sourceControl: SourceControlService,
  path: string | undefined,
  requeue: () => Promise<boolean>,
): Promise<boolean> {
  if (path !== undefined) assertWritableUnderLock(sourceControl, path);
  const queued = await requeue();
  if (queued && path !== undefined) void afterMutatingApply(sourceControl, path);
  return queued;
}
