import { registerPlugin } from "@capacitor/core";

/**
 * First-party file export in the iOS and Android shells. The file reaches the
 * native side in base64 chunks written to a temporary file, never as one
 * bridge string, then `finish` offers it: the share sheet on iOS (Save to
 * Files among its actions), the system save dialog on Android. The native side
 * deletes the temporary file when `finish` settles or `discard` is called.
 */
export interface BabylonSlateFileExportPlugin {
  begin(options: { name: string; mimeType: string }): Promise<{ id: string }>;
  append(options: { id: string; data: string }): Promise<void>;
  /** Resolves when the share sheet or save dialog closes. */
  finish(options: { id: string }): Promise<{ result: "shared" | "saved" | "cancelled" }>;
  discard(options: { id: string }): Promise<void>;
}

export const BabylonSlateFileExport =
  registerPlugin<BabylonSlateFileExportPlugin>("BabylonSlateFileExport");
