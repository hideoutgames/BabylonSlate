import { downloadBlob } from "./download";
import { pluginDownloadFileName } from "./plugin-ui";

/** Save zip bytes through the editor's anchor download. */
export function downloadZipArchive(bytes: Uint8Array, fileName: string): void {
  downloadBlob(new Blob([Uint8Array.from(bytes)], { type: "application/zip" }), fileName);
}

/** Use the same archive download path for project and Engine Plugins. */
export function downloadPluginArchive(
  bytes: Uint8Array,
  displayName: string,
): void {
  downloadZipArchive(bytes, pluginDownloadFileName(displayName));
}
