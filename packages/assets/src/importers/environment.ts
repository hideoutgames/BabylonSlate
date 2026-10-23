import { readEnvironmentTextureInfo } from "../environment-texture";
import { newAssetGuid } from "../guid";
import { convertRadianceHdrToEnvironmentDds } from "../hdr-environment";
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
 * import, so the stored Texture loads like any imported DDS environment.
 */
export async function importRadianceEnvironmentTexture(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  return [environmentTextureResult(await convertRadianceHdrToEnvironmentDds(bytes), options.fileName)];
}
