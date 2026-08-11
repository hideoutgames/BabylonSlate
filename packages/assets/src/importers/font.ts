import { newAssetGuid } from "../guid";
import type { ImportOptions, ImportResult } from "./types";
import { baseName, extensionOf } from "./util";

export const FONT_EXTENSIONS = new Set(["woff2", "woff", "ttf", "otf"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

function isMsdfFile(fileName: string): boolean {
  return /msdf/i.test(fileName);
}

/**
 * facetype.js and msdf atlas JSON describe glyph representations for a font
 * that should already exist rather than a new asset; matched by filename
 * convention or, failing that, by shape (`facetype` / `chars` / `atlas` keys).
 */
export function isFontRepresentationFile(fileName: string, bytes: Uint8Array): boolean {
  if (extensionOf(fileName) !== "json") return false;
  if (/msdf|facetype/i.test(fileName)) return true;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      ("facetype" in parsed || "chars" in parsed || "atlas" in parsed)
    );
  } catch {
    return false;
  }
}

/** Strips a trailing `-msdf` / `.facetype` style marker to recover the font family name. */
export function fontFamilyFromRepresentationFileName(fileName: string): string {
  return baseName(fileName).replace(/[-._]?(msdf|facetype)$/i, "");
}

export async function importFont(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  if (isFontRepresentationFile(options.fileName, bytes)) {
    const family = fontFamilyFromRepresentationFileName(options.fileName);
    const existingGuid = options.fontGuidsByName?.get(family);
    const chunkId = isMsdfFile(options.fileName) ? "msdf-atlas" : "facetype-glyphs";
    const chunkKind = isMsdfFile(options.fileName) ? "font-msdf" : "font-facetype";

    const result: ImportResult = {
      type: "Font",
      name: family,
      guid: existingGuid ?? newAssetGuid(),
      version: 1,
      dependencies: [],
      parentClass: null,
      payload: {},
      chunks: [{ id: chunkId, kind: chunkKind, mime: "application/json", data: bytes }],
    };
    if (existingGuid) {
      result.attachToGuid = existingGuid;
    }
    return [result];
  }

  const extension = extensionOf(options.fileName);
  const mime = MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
  return [
    {
      type: "Font",
      name: baseName(options.fileName),
      guid: newAssetGuid(),
      version: 1,
      dependencies: [],
      parentClass: null,
      payload: {},
      chunks: [{ id: "source", kind: "font", mime, data: bytes }],
    },
  ];
}
