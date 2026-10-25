import { downloadZipArchive } from "./download";
import { pluginDownloadFileName } from "./plugin-ui";

/** Use the same archive download path for project and Engine Plugins. */
export function downloadPluginArchive(
  bytes: Uint8Array,
  displayName: string,
): void {
  downloadZipArchive(bytes, pluginDownloadFileName(displayName));
}
