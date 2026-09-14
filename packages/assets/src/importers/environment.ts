import { readEnvironmentTextureInfo } from "../environment-texture";
import { newAssetGuid } from "../guid";
import type { ImportOptions, ImportResult } from "./types";
import { baseName, extensionOf } from "./util";

/** Retain the authored HDR cube and its roughness mips, without 2D re-encoding. */
export async function importEnvironmentTexture(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  const info = readEnvironmentTextureInfo(bytes);
  if (extensionOf(options.fileName) !== info.container)
    throw new Error(
      "Environment file extension does not match its ENV/DDS contents.",
    );
  return [
    {
      type: "Texture",
      name: baseName(options.fileName),
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
    },
  ];
}
