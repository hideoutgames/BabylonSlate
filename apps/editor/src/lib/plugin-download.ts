import { pluginDownloadFileName } from "./plugin-ui";

/**
 * Some browsers resolve an anchor download's blob URL after the click returns,
 * so the URL is released later rather than in the same turn.
 */
const DOWNLOAD_URL_LIFETIME_MS = 40_000;

/** Save zip bytes through a temporary anchor download. */
export function downloadZipArchive(bytes: Uint8Array, fileName: string): void {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: "application/zip" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
  }
}

/** Use the same archive download path for project and Engine Plugins. */
export function downloadPluginArchive(
  bytes: Uint8Array,
  displayName: string,
): void {
  downloadZipArchive(bytes, pluginDownloadFileName(displayName));
}
