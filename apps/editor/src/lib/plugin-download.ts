import type { SaveFileResult } from "@haptic/vfs";
import { saveZipArchive } from "./file-export";
import { pluginDownloadFileName } from "./plugin-ui";

/** Use the same archive save path for project and Engine Plugins. */
export function savePluginArchive(
  bytes: Uint8Array,
  displayName: string,
): Promise<SaveFileResult> {
  return saveZipArchive(bytes, pluginDownloadFileName(displayName));
}
