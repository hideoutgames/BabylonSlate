import { readEnvironmentTextureInfo } from "../environment-texture";
import { newAssetGuid } from "../guid";
import {
  convertRadianceHdrToEnvironmentDds,
  HDR_SOURCE_CHUNK_ID,
  HDR_SOURCE_MIME,
  normalizeHdrEnvironmentFaceSize,
} from "../hdr-environment";
import type { ImportOptions, ImportResult } from "./types";
import { baseName, extensionOf } from "./util";

function environmentTextureResult(bytes: Uint8Array, fileName: string): ImportResult {
  const info = readEnvironmentTextureInfo(bytes);
  return {
    type: "Texture",
    name: baseName(fileName),
    guid: newAssetGuid(),
    version: 1,
    dependencies: [],
    parentClass: null,
    payload: { usage: "skybox", ...info },
    chunks: [
      {
        id: "source",
        kind: "source",
        mime:
          info.container === "env"
            ? "application/vnd.babylon.env"
            : "image/vnd-ms.dds",
        data: bytes,
      },
    ],
  };
}

/** Retain the authored HDR cube and its roughness mips, without 2D re-encoding. */
export async function importEnvironmentTexture(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  if (extensionOf(options.fileName) !== readEnvironmentTextureInfo(bytes).container)
    throw new Error(
      "Environment file extension does not match its ENV/DDS contents.",
    );
  return [environmentTextureResult(bytes, options.fileName)];
}

/**
 * Convert an equirectangular Radiance HDR to a prefiltered float DDS cube at
 * import, so the stored Texture loads like any imported DDS environment. The
 * `.hdr` stays in its own chunk, which nothing loads at runtime, so a Face
 * Size change can convert it again.
 */
export async function importRadianceEnvironmentTexture(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  const faceSize = normalizeHdrEnvironmentFaceSize(options.hdrFaceSize);
  const dds = await convertRadianceHdrToEnvironmentDds(bytes, {
    faceSize,
    signal: options.signal,
    onProgress: options.onProgress,
  });
  const result = environmentTextureResult(dds, options.fileName);
  result.payload.hdrFaceSize = faceSize;
  result.chunks.push({ id: HDR_SOURCE_CHUNK_ID, kind: HDR_SOURCE_CHUNK_ID, mime: HDR_SOURCE_MIME, data: bytes });
  return [result];
}
