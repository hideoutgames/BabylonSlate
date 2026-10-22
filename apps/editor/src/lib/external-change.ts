import type { ProjectStorage } from "@haptic/core";
import { PROJECT_FILE } from "@haptic/core";

export async function readProjectJsonMtime(
  storage: ProjectStorage,
): Promise<number | null> {
  try {
    if (!(await storage.exists(PROJECT_FILE))) return null;
    return (await storage.stat(PROJECT_FILE)).mtime;
  } catch {
    return null;
  }
}

/** Recapture after Save All / compile-on-save so our project.json is not Reload Project. */
export async function refreshMtimeSnapshotAfterEditorSave(
  captureMtimeSnapshot: () => Promise<void>,
): Promise<void> {
  await captureMtimeSnapshot();
}
