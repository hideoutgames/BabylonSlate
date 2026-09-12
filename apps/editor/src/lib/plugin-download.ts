import { pluginDownloadFileName } from "./plugin-ui";

/** Use the same archive download path for project and Engine Plugins. */
export function downloadPluginArchive(
  bytes: Uint8Array,
  displayName: string,
): void {
  const blob = new Blob([Uint8Array.from(bytes)], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = pluginDownloadFileName(displayName);
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
