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
