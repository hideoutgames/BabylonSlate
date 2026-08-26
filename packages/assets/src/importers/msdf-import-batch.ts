import {
  isMsdfAtlasPng,
  isMsdfJsonFile,
  msdfJsonAtlasPageNames,
} from "./font";
import type { ImportFileBytes } from "./obj-import-batch";
import { extensionOf } from "./util";

function fileNameOf(fileName: string): string {
  return (fileName.split(/[\\/]/).pop() ?? fileName).toLowerCase();
}

function pngMatchesJson(png: ImportFileBytes, json: ImportFileBytes): boolean {
  if (isMsdfAtlasPng(png.name) && isMsdfJsonFile(json.name, json.bytes)) {
    const jsonFamily = fileNameOf(json.name).replace(/\.json$/i, "");
    const pngFamily = fileNameOf(png.name).replace(/\.png$/i, "");
    if (jsonFamily.replace(/[-._]?msdf$/i, "") === pngFamily.replace(/[-._]?msdf$/i, "")) {
      return true;
    }
  }
  const pages = msdfJsonAtlasPageNames(json.bytes).map(fileNameOf);
  const pngName = fileNameOf(png.name);
  return pages.includes(pngName);
}

/** Pair MSDF JSON with a companion PNG so the PNG is not imported as a Texture. */
export function groupMsdfImportBatch(
  files: ImportFileBytes[],
): Array<ImportFileBytes & { sidecars?: Record<string, Uint8Array> }> {
  const jsons = files.filter((file) => isMsdfJsonFile(file.name, file.bytes));
  const pngs = files.filter((file) => extensionOf(file.name) === "png");
  const consumed = new Set<ImportFileBytes>();
  const prepared: Array<ImportFileBytes & { sidecars?: Record<string, Uint8Array> }> =
    [];

  for (const json of jsons) {
    const png = pngs.find(
      (candidate) => !consumed.has(candidate) && pngMatchesJson(candidate, json),
    );
    if (png) {
      consumed.add(png);
      prepared.push({
        ...json,
        sidecars: {
          [png.name]: png.bytes,
          [fileNameOf(png.name)]: png.bytes,
        },
      });
    } else {
      prepared.push(json);
    }
  }

  for (const file of files) {
    if (jsons.includes(file) || consumed.has(file)) continue;
    prepared.push(file);
  }
  return prepared;
}
