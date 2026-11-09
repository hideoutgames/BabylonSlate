import { saveFile, type SaveFileResult } from "@haptic/vfs";

/**
 * Saves zip bytes as `fileName` through `saveFile`: exactly the view's bytes,
 * even when it shares a larger buffer, without an extra copy of a large Export
 * Game archive. Every producer is fflate output on a plain `ArrayBuffer`; a
 * `SharedArrayBuffer` view would make `Blob` throw.
 */
export function saveZipArchive(bytes: Uint8Array, fileName: string): Promise<SaveFileResult> {
  return saveExportFile(bytes, fileName, "application/zip");
}

/** Saves an exported file's bytes as `fileName` with its media type, without copying a large package. */
export function saveExportFile(bytes: Uint8Array, fileName: string, type: string): Promise<SaveFileResult> {
  return saveFile(fileName, new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
}

/**
 * The notice after an export, true to how this host saved it: a download
 * points at the downloads, a save dialog or share sheet does not. A cancelled
 * share sheet or save dialog is not an error and shows none.
 */
export function savedFileNotice(subject: string, result: SaveFileResult): string | null {
  switch (result) {
    case "downloaded":
      return `${subject} downloaded. Check your downloads.`;
    case "saved":
      return `${subject} saved.`;
    case "shared":
      return `${subject} exported.`;
    case "cancelled":
      return null;
  }
}
