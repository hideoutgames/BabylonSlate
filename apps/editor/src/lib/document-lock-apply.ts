import type { SourceControlService } from "../services/source-control-service";

/** True when apply* should no-op (plugin or advisory lock read-only). */
export function isMutatingApplyBlocked(
  sourceControl: SourceControlService,
  path: string,
  pluginReadOnly: boolean,
): boolean {
  if (pluginReadOnly) return true;
  return sourceControl.isDocumentReadOnly(path);
}

/** First-edit lock after a successful apply. Never throws; never blocks. */
export function afterMutatingApply(
  sourceControl: SourceControlService,
  path: string,
): Promise<void> {
  return sourceControl.autoLock(path);
}

/**
 * Texture Details' re-encode (Retry Encoding, or a Details change) rewrites the
 * Texture file, so an accepted requeue locks it like any other edit.
 */
export async function requeueWithEditLock(
  sourceControl: SourceControlService,
  path: string | undefined,
  requeue: () => Promise<boolean>,
): Promise<boolean> {
  const queued = await requeue();
  if (queued && path !== undefined) void afterMutatingApply(sourceControl, path);
  return queued;
}
