import { unzipSync } from "fflate";

/** The files of an exported game zip, by path. */
export function unzipExport(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}
