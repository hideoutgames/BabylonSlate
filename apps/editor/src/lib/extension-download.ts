import { downloadZipArchive } from "./plugin-download";

/** Same download interaction as Plugins, with a distinct editor package format. */
export function downloadExtensionArchive(bytes: Uint8Array, name: string): void {
  const filename = [...name].map((character) => character.charCodeAt(0) < 32 ? "_" : character).join("").replace(/[\\/:<>"|?*]/g, "_");
  downloadZipArchive(bytes, `${filename || "extension"}.hextension`);
}
