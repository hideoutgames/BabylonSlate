import { newAssetGuid } from "../guid";
import { sniffSourceImageSize } from "../image-size";
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

const PIXEL_ART_WORDS = new Set(["pixel", "pixels", "pixelart", "sprite", "sprites", "spritesheet", "tileset", "tilesets"]);
const UI_WORDS = new Set(["ui", "gui", "hud", "button", "buttons"]);
const NORMAL_WORDS = new Set(["normal", "normals", "normalmap"]);

/** Words of a file name: split at separators, digits and camelCase humps. */
function fileNameWords(fileName: string): string[] {
  return baseName(fileName)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** Usage from whole words of the name, so `abnormal` or `buttonhole` stay Albedo. */
function usageFromFileName(fileName: string): string {
  const words = fileNameWords(fileName);
  const joined = ` ${words.join(" ")} `;
  if (words.some((word) => PIXEL_ART_WORDS.has(word))) return "pixelArt";
  if (words.includes("lut") || words.includes("colorgrading") || joined.includes(" color grading ")) return "colorGrading";
  if (words.some((word) => UI_WORDS.has(word))) return "ui";
  if (words.some((word) => NORMAL_WORDS.has(word))) return "normal";
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
  const size = sniffSourceImageSize(bytes);
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
