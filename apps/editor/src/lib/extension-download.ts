import type { SaveFileResult } from "@haptic/vfs";
import { saveZipArchive } from "./file-export";

/** Same save interaction as Plugins, with a distinct editor package format. */
export function saveExtensionArchive(bytes: Uint8Array, name: string): Promise<SaveFileResult> {
  const filename = [...name].map((character) => character.charCodeAt(0) < 32 ? "_" : character).join("").replace(/[\\/:<>"|?*]/g, "_");
  return saveZipArchive(bytes, `${filename || "extension"}.hextension`);
}
