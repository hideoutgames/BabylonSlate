import { newAssetGuid } from "../guid";
import type { ImportOptions, ImportResult } from "./types";
import { baseName, extensionOf } from "./util";

export const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

export async function importAudio(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  const extension = extensionOf(options.fileName);
  const mime = MIME_BY_EXTENSION[extension] ?? "application/octet-stream";

  return [
    {
      type: "Audio",
      name: baseName(options.fileName),
      guid: newAssetGuid(),
      version: 1,
      dependencies: [],
      parentClass: null,
      payload: {},
      chunks: [{ id: "source", kind: "audio", mime, data: bytes }],
    },
  ];
}
