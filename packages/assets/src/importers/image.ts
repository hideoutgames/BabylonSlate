import { newAssetGuid } from "../guid";
import { sniffSourceImageSize, type ImageSize } from "../image-size";
import {
  formatImportCount,
  IMPORT_IMAGE_MAX_EDGE,
  IMPORT_IMAGE_MAX_PIXELS,
  importLimitError,
} from "../import-limits";
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

/**
 * Usage from whole words of the name, so `abnormal` or `buttonhole` stay Albedo. A name that names no Usage falls
 * back to `fallback`: Albedo, or Pixel Art in a project with Nearest Texture Filtering.
 */
function usageFromFileName(fileName: string, fallback: "albedo" | "pixelArt"): string {
  const words = fileNameWords(fileName);
  const joined = ` ${words.join(" ")} `;
  if (words.some((word) => PIXEL_ART_WORDS.has(word))) return "pixelArt";
  if (words.includes("lut") || words.includes("colorgrading") || joined.includes(" color grading ")) return "colorGrading";
  if (words.some((word) => UI_WORDS.has(word))) return "ui";
  if (words.some((word) => NORMAL_WORDS.has(word))) return "normal";
  return fallback;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  bytes.length >= at + signature.length && signature.every((byte, index) => bytes[at + index] === byte);
const ascii = (text: string) => Array.from(text, (character) => character.charCodeAt(0));
// "\x89PNG"; the line-ending bytes after it are not needed to tell a PNG apart.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

/** Whether `bytes` start like a PNG, JPEG, WebP or GIF, whatever the file's extension says. */
export function hasImageSignature(bytes: Uint8Array): boolean {
  return startsWith(bytes, PNG_SIGNATURE) ||
    startsWith(bytes, JPEG_SIGNATURE) ||
    startsWith(bytes, ascii("GIF87a")) ||
    startsWith(bytes, ascii("GIF89a")) ||
    (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8));
}

/**
 * Refuses an image larger than {@link IMPORT_IMAGE_MAX_EDGE} on a side or
 * {@link IMPORT_IMAGE_MAX_PIXELS} in all, from the size its header records,
 * before anything decodes it. `what` names it in the message.
 */
export function assertImageSizeWithinLimits(size: ImageSize | null, what: string): void {
  if (!size) return;
  const { width, height } = size;
  if (Math.max(width, height) > IMPORT_IMAGE_MAX_EDGE || width * height > IMPORT_IMAGE_MAX_PIXELS) {
    throw importLimitError(
      `The size of ${what}`,
      `${formatImportCount(width)} × ${formatImportCount(height)} pixels`,
      `${formatImportCount(IMPORT_IMAGE_MAX_EDGE)} × ${formatImportCount(IMPORT_IMAGE_MAX_EDGE)}`,
      "Resize it in an image editor before importing.",
    );
  }
}

/** Images become a Texture asset with a pending compression state (§3.5). */
export async function importImage(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  if (!hasImageSignature(bytes)) {
    throw new Error("The file is not a PNG, JPEG, WebP or GIF image: its contents do not start with an image signature.");
  }
  const extension = extensionOf(options.fileName);
  const mime = MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
  const usage = usageFromFileName(options.fileName, options.nearestTextures ? "pixelArt" : "albedo");
  const payload: Record<string, unknown> = { usage };
  const size = sniffSourceImageSize(bytes);
  assertImageSizeWithinLimits(size, "the image");
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
