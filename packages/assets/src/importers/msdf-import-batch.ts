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

/**
 * A JSON that names its atlas page pairs only with that file; one that names
 * none pairs with the `msdf` PNG of the same family.
 */
function pngMatchesJson(png: ImportFileBytes, json: ImportFileBytes): boolean {
  const pages = msdfJsonAtlasPageNames(json.bytes).map(fileNameOf);
  if (pages.length > 0) return pages.includes(fileNameOf(png.name));
  if (!isMsdfAtlasPng(png.name) || !isMsdfJsonFile(json.name, json.bytes)) return false;
  const jsonFamily = fileNameOf(json.name).replace(/\.json$/i, "");
  const pngFamily = fileNameOf(png.name).replace(/\.png$/i, "");
  return jsonFamily.replace(/[-._]?msdf$/i, "") === pngFamily.replace(/[-._]?msdf$/i, "");
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

/**
 * Why an Import MSDF Atlas… pick cannot attach to a Font, or null when it can.
 * It needs a JSON and a PNG, and every PNG must pair with an MSDF JSON: an
 * unpaired one would import on its own and attach to the Font as a Texture
 * chunk or as a second atlas.
 */
export function msdfAtlasPickError(files: ImportFileBytes[]): string | null {
  const hasJson = files.some((file) => extensionOf(file.name) === "json");
  const hasPng = files.some((file) => extensionOf(file.name) === "png");
  if (!hasJson || !hasPng) return "MSDF needs both JSON and PNG.";
  const unpaired = groupMsdfImportBatch(files).find(
    (file) => extensionOf(file.name) === "png",
  );
  return unpaired ? `${unpaired.name} is not the atlas PNG for the MSDF JSON.` : null;
}
