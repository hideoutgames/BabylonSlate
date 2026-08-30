import { importAudio } from "./audio";
import { importBabasset } from "./babasset";
import { importFont, isMsdfAtlasPng } from "./font";
import { importImage } from "./image";
import { importModel } from "./model";
import type { ImportOptions, ImportResult, Importer } from "./types";
import { extensionOf } from "./util";

const IMPORTERS_BY_EXTENSION: Record<string, Importer> = {
  png: importImage,
  jpg: importImage,
  jpeg: importImage,
  webp: importImage,
  gif: importImage,
  glb: importModel,
  gltf: importModel,
  mp3: importAudio,
  wav: importAudio,
  ogg: importAudio,
  woff2: importFont,
  woff: importFont,
  ttf: importFont,
  otf: importFont,
  json: importFont,
  babasset: importBabasset,
};

export function importerForExtension(extension: string): Importer | undefined {
  return IMPORTERS_BY_EXTENSION[extension.toLowerCase()];
}

/** Comma-separated `accept` for the Content Browser file picker (no OBJ — converted first). */
export function registeredImportAccept(): string {
  return Object.keys(IMPORTERS_BY_EXTENSION)
    .map((extension) => `.${extension}`)
    .join(",");
}

/** Picker accept list: registered importers plus OBJ/MTL and glTF BIN sidecars. */
export function pickerImportAccept(): string {
  return `${registeredImportAccept()},.obj,.mtl,.bin`;
}

export async function importByExtension(
  fileName: string,
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  const extension = extensionOf(fileName);
  if (extension === "png" && isMsdfAtlasPng(fileName)) {
    return importFont(bytes, { ...options, fileName });
  }
  const importer = importerForExtension(extension);
  if (!importer) {
    throw new Error(`No importer registered for ".${extension}" files`);
  }
  return importer(bytes, options);
}

export * from "./audio";
export * from "./babasset";
export * from "./font";
export * from "./glb-parse";
export * from "./guid-remap";
export * from "./image";
export * from "./model";
export * from "./gltf-import-batch";
export * from "./msdf-import-batch";
export * from "./obj-import-batch";
export * from "./types";
export * from "./util";
