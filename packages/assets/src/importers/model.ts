import { newAssetGuid } from "../guid";
import type { ImportOptions, ImportResult } from "./types";
import { baseName, extensionOf } from "./util";

export const MODEL_EXTENSIONS = new Set(["glb", "gltf", "obj", "stl"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "model/obj",
  stl: "model/stl",
};

/**
 * Models import as a Model asset plus stub Material / Texture / Animation
 * children so the dependency graph is exercised end to end even before the
 * real mesh/material extraction lands.
 */
export async function importModel(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  const extension = extensionOf(options.fileName);
  const mime = MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
  const name = baseName(options.fileName);

  const textureGuid = newAssetGuid();
  const materialGuid = newAssetGuid();
  const animationGuid = newAssetGuid();
  const modelGuid = newAssetGuid();

  const texture: ImportResult = {
    type: "Texture",
    name: `${name}_Texture`,
    guid: textureGuid,
    version: 1,
    dependencies: [],
    parentClass: null,
    payload: { compressionState: "pending", usage: "albedo" },
    chunks: [],
  };

  const material: ImportResult = {
    type: "Material",
    name: `${name}_Material`,
    guid: materialGuid,
    version: 1,
    dependencies: [textureGuid],
    parentClass: null,
    payload: {},
    chunks: [],
  };

  const animation: ImportResult = {
    type: "Animation",
    name: `${name}_Animation`,
    guid: animationGuid,
    version: 1,
    dependencies: [],
    parentClass: null,
    payload: {},
    chunks: [],
  };

  const model: ImportResult = {
    type: "Model",
    name,
    guid: modelGuid,
    version: 1,
    dependencies: [materialGuid, animationGuid],
    parentClass: null,
    payload: {},
    chunks: [{ id: "source", kind: "geometry", mime, data: bytes }],
  };

  return [model, material, texture, animation];
}
