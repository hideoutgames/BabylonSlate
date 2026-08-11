import { importAudio } from "./audio";
import { importBabasset } from "./babasset";
import { importFont } from "./font";
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
  obj: importModel,
  stl: importModel,
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

export async function importByExtension(
  fileName: string,
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  const extension = extensionOf(fileName);
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
export * from "./types";
export * from "./util";
