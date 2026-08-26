import { newAssetGuid } from "../guid";
import { createFontPayload } from "../font-payload";
import type { ImportOptions, ImportResult, ImportResultChunk } from "./types";
import { baseName, extensionOf } from "./util";

export const FONT_EXTENSIONS = new Set(["woff2", "woff", "ttf", "otf"]);

/** Glyph JSON chunk attached to a Font for flat 3D Text (`CreateTextShapePaths`). */
export const FONT_FACETYPE_CHUNK_ID = "facetype-glyphs";

/** bmfont JSON for overlay MSDF glyphs. */
export const FONT_MSDF_CHUNK_ID = "msdf-atlas";

/** Atlas PNG companion for `FONT_MSDF_CHUNK_ID`. */
export const FONT_MSDF_PNG_CHUNK_ID = "msdf-atlas-png";

const MIME_BY_EXTENSION: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

export function isMsdfAtlasPng(fileName: string): boolean {
  return extensionOf(fileName) === "png" && /msdf/i.test(fileName);
}

function isMsdfFileName(fileName: string): boolean {
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

export function isMsdfJsonFile(fileName: string, bytes: Uint8Array): boolean {
  if (!isFontRepresentationFile(fileName, bytes)) return false;
  if (isMsdfFileName(fileName)) return true;
  if (/facetype/i.test(fileName)) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
    return (
      Array.isArray(parsed.chars) ||
      Array.isArray(parsed.pages) ||
      "atlas" in parsed
    );
  } catch {
    return false;
  }
}

/** Strips a trailing `-msdf` / `.facetype` style marker to recover the font family name. */
export function fontFamilyFromRepresentationFileName(fileName: string): string {
  return baseName(fileName).replace(/[-._]?(msdf|facetype)$/i, "");
}

export function msdfJsonAtlasPageNames(bytes: Uint8Array): string[] {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<
      string,
      unknown
    >;
    const names: string[] = [];
    if (Array.isArray(parsed.pages)) {
      for (const page of parsed.pages) {
        if (typeof page === "string" && page.trim()) names.push(page.trim());
        else if (page && typeof page === "object") {
          const file = (page as { file?: unknown }).file;
          if (typeof file === "string" && file.trim()) names.push(file.trim());
        }
      }
    }
    if (typeof parsed.atlas === "string" && parsed.atlas.trim()) {
      names.push(parsed.atlas.trim());
    }
    return names;
  } catch {
    return [];
  }
}

function sidecarLookup(
  sidecars: ImportOptions["sidecars"],
): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  if (!sidecars) return map;
  const entries =
    sidecars instanceof Map ? [...sidecars.entries()] : Object.entries(sidecars);
  for (const [key, value] of entries) {
    map.set(key, value);
    map.set(key.toLowerCase(), value);
    const base = key.split(/[\\/]/).pop();
    if (base) {
      map.set(base, value);
      map.set(base.toLowerCase(), value);
    }
  }
  return map;
}

function findMsdfPngSidecar(
  jsonBytes: Uint8Array,
  sidecars: ImportOptions["sidecars"],
): { name: string; bytes: Uint8Array } | null {
  const map = sidecarLookup(sidecars);
  if (map.size === 0) return null;
  const candidates = [
    ...msdfJsonAtlasPageNames(jsonBytes),
    ...[...map.keys()].filter((name) => isMsdfAtlasPng(name)),
  ];
  for (const name of candidates) {
    const bytes =
      map.get(name) ??
      map.get(name.toLowerCase()) ??
      map.get(name.split(/[\\/]/).pop() ?? "") ??
      map.get((name.split(/[\\/]/).pop() ?? "").toLowerCase());
    if (bytes) return { name, bytes };
  }
  return null;
}

function fontResult(options: {
  family: string;
  existingGuid?: string;
  representations: {
    source?: boolean;
    facetype?: boolean;
    msdfJson?: boolean;
    msdfPng?: boolean;
  };
  chunks: ImportResultChunk[];
}): ImportResult {
  const existingGuid = options.existingGuid;
  return {
    type: "Font",
    name: options.family,
    guid: existingGuid ?? newAssetGuid(),
    version: 1,
    dependencies: [],
    parentClass: null,
    payload: createFontPayload(options.family, {
      representations: options.representations,
    }) as unknown as Record<string, unknown>,
    chunks: options.chunks,
    ...(existingGuid ? { attachToGuid: existingGuid } : {}),
  };
}

export async function importFont(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  const forcedGuid = options.attachToGuid;
  if (extensionOf(options.fileName) === "png") {
    const family = fontFamilyFromRepresentationFileName(options.fileName);
    const existingGuid = forcedGuid ?? options.fontGuidsByName?.get(family);
    return [
      fontResult({
        family,
        existingGuid,
        representations: { source: false, msdfPng: true },
        chunks: [
          {
            id: FONT_MSDF_PNG_CHUNK_ID,
            kind: "font-msdf-png",
            mime: "image/png",
            data: bytes,
          },
        ],
      }),
    ];
  }

  if (isFontRepresentationFile(options.fileName, bytes)) {
    const family = fontFamilyFromRepresentationFileName(options.fileName);
    const existingGuid = forcedGuid ?? options.fontGuidsByName?.get(family);
    const msdf = isMsdfJsonFile(options.fileName, bytes);
    const chunks: ImportResultChunk[] = [
      {
        id: msdf ? FONT_MSDF_CHUNK_ID : FONT_FACETYPE_CHUNK_ID,
        kind: msdf ? "font-msdf" : "font-facetype",
        mime: "application/json",
        data: bytes,
      },
    ];
    const png = msdf ? findMsdfPngSidecar(bytes, options.sidecars) : null;
    if (png) {
      chunks.push({
        id: FONT_MSDF_PNG_CHUNK_ID,
        kind: "font-msdf-png",
        mime: "image/png",
        data: png.bytes,
      });
    }
    return [
      fontResult({
        family,
        existingGuid,
        representations: msdf
          ? { source: false, msdfJson: true, msdfPng: Boolean(png) }
          : { source: false, facetype: true },
        chunks,
      }),
    ];
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
      payload: createFontPayload(baseName(options.fileName), {
        representations: { source: true, facetype: false, msdf: false },
      }) as unknown as Record<string, unknown>,
      chunks: [{ id: "source", kind: "font", mime, data: bytes }],
    },
  ];
}

export function msdfAtlasPickError(
  files: ReadonlyArray<{ name: string }>,
): string | null {
  const hasJson = files.some((file) => extensionOf(file.name) === "json");
  const hasPng = files.some((file) => extensionOf(file.name) === "png");
  if (hasJson && hasPng) return null;
  return "MSDF needs both JSON and PNG.";
}
