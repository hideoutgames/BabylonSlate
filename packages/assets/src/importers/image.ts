import { newAssetGuid } from "../guid";
import { sniffImageSize } from "../image-size";
import { shouldCompressTexture } from "../texture-compression";
import type { ImportOptions, ImportResult } from "./types";
import { baseName, extensionOf } from "./util";

export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

function usageFromFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (/(pixel|sprite|tileset)/.test(lower)) return "pixelArt";
  if (/(ui[_-]|hud[_-]|button)/.test(lower)) return "ui";
  if (/normal/.test(lower)) return "normal";
  return "albedo";
}

/** Images become a Texture asset with a pending compression state (§3.5). */
export async function importImage(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  const extension = extensionOf(options.fileName);
  const mime = MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
  const usage = usageFromFileName(options.fileName);
  const payload: Record<string, unknown> = { usage };
  const size = sniffImageSize(bytes);
  if (size) {
    payload.width = size.width;
    payload.height = size.height;
  }
  if (shouldCompressTexture(usage)) {
    payload.compressionState = "pending";
  }

  return [
    {
      type: "Texture",
      name: baseName(options.fileName),
      guid: newAssetGuid(),
      version: 1,
      dependencies: [],
      parentClass: null,
      payload,
      chunks: [{ id: "pixels", kind: "pixels", mime, data: bytes }],
    },
  ];
}
