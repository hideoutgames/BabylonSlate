import { emptySkyboxFaces, type SkyboxFaces } from "@babylonslate/core";
import {
  createSkyboxFaceTextureResult,
  fitSourceIntoSkyboxNet,
  sniffRasterImageMime,
  normalizeSkyboxCreatorPayload,
  planSkyboxCreatorFaceWrites,
  stripAssetFileSuffix,
  type ImportResult,
  type SkyboxCreatorPayload,
} from "@babylonslate/assets";

export function relativePathUnderPrefix(
  path: string,
  pathPrefix: string,
): string {
  if (path === pathPrefix) return "";
  if (path.startsWith(`${pathPrefix}/`)) {
    return path.slice(pathPrefix.length + 1);
  }
  return path;
}

export async function writeSkyboxCreatorFaceAssets(options: {
  helperPath: string;
  payload: SkyboxCreatorPayload;
  rgba: Uint8Array;
  width: number;
  height: number;
  existingByGuid: ReadonlyMap<string, { path: string }>;
  occupiedPaths: ReadonlySet<string>;
  rootId: string;
  pathPrefix: string;
  encodePng: (width: number, height: number, rgba: Uint8Array) => Uint8Array;
  newGuid: () => string;
  createAsset: (
    rootId: string,
    relativePath: string,
    result: ImportResult,
  ) => Promise<unknown>;
  deleteAsset: (guid: string) => Promise<void>;
}): Promise<SkyboxFaces> {
  const helper = normalizeSkyboxCreatorPayload(options.payload);
  const sliced = fitSourceIntoSkyboxNet(
    options.rgba,
    options.width,
    options.height,
    helper.sourcePlacement,
  );
  const writes = planSkyboxCreatorFaceWrites({
    helperPath: options.helperPath,
    generatedFaces: helper.generatedFaces,
    existingByGuid: options.existingByGuid,
    occupiedPaths: options.occupiedPaths,
    newGuid: options.newGuid,
  });
  const faces = emptySkyboxFaces();
  for (const write of writes) {
    const face = sliced.faces[write.key];
    const png = options.encodePng(face.size, face.size, face.rgba);
    const fileName = write.path.includes("/")
      ? write.path.slice(write.path.lastIndexOf("/") + 1)
      : write.path;
    const relative = relativePathUnderPrefix(write.path, options.pathPrefix);
    if (write.replace) await options.deleteAsset(write.guid);
    await options.createAsset(
      options.rootId,
      relative,
      createSkyboxFaceTextureResult({
        name: stripAssetFileSuffix(fileName),
        guid: write.guid,
        pngBytes: png,
      }),
    );
    faces[write.key] = write.guid;
  }
  return faces;
}

export type TextureImageBytes = {
  bytes: Uint8Array;
  mime: string | null;
};

export async function readTextureImageBytes(
  readAssetChunk: (path: string, chunkId: string) => Promise<Uint8Array | null>,
  path: string,
): Promise<TextureImageBytes | null> {
  const pixels = await readAssetChunk(path, "pixels");
  const source = await readAssetChunk(path, "source");
  const pixelsMime =
    pixels && pixels.byteLength > 0 ? sniffRasterImageMime(pixels) : null;
  if (pixels && pixelsMime) {
    return { bytes: pixels, mime: pixelsMime };
  }
  if (source && source.byteLength > 0) {
    return { bytes: source, mime: sniffRasterImageMime(source) };
  }
  if (pixels && pixels.byteLength > 0) {
    return { bytes: pixels, mime: null };
  }
  return null;
}
