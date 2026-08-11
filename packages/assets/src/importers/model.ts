import { newAssetGuid } from "../guid";
import type { ImportOptions, ImportResult } from "./types";
import { baseName, extensionOf } from "./util";
import {
  parseGlbForBrowse,
  parseGltfJsonForBrowse,
  type GlbBrowseParse,
} from "./glb-parse";

export const MODEL_EXTENSIONS = new Set(["glb", "gltf", "obj", "stl"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "model/obj",
  stl: "model/stl",
};

/**
 * Models import as a Model asset plus browsable Material / Texture / Animation
 * dependents. GLB/glTF parse enough of the container for CB headers and
 * embedded albedo images; mesh runtime fidelity can stay thin until Play.
 */
export async function importModel(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  const extension = extensionOf(options.fileName);
  const mime = MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
  const name = baseName(options.fileName);

  const browse =
    extension === "glb"
      ? parseGlbForBrowse(bytes)
      : extension === "gltf"
        ? parseGltfJsonForBrowse(new TextDecoder().decode(bytes))
        : null;

  if (browse && (browse.materials.length > 0 || browse.images.length > 0)) {
    return importFromBrowse(name, mime, bytes, browse);
  }

  return importStubDependents(name, mime, bytes);
}

function importFromBrowse(
  name: string,
  mime: string,
  bytes: Uint8Array,
  browse: GlbBrowseParse,
): ImportResult[] {
  const results: ImportResult[] = [];
  const imageGuids: string[] = [];

  for (const image of browse.images) {
    const guid = newAssetGuid();
    imageGuids.push(guid);
    const chunks =
      image.bytes.byteLength > 0
        ? [
            {
              id: "pixels",
              kind: "pixels",
              mime: image.mime,
              data: image.bytes,
            },
          ]
        : [];
    results.push({
      type: "Texture",
      name: `${name}_${image.name}`,
      guid,
      version: 1,
      dependencies: [],
      parentClass: null,
      payload: {
        compressionState: chunks.length > 0 ? "pending" : "pending",
        usage: "albedo",
      },
      chunks,
    });
  }

  const materialGuids: string[] = [];
  if (browse.materials.length === 0) {
    const textureGuid = imageGuids[0] ?? newAssetGuid();
    if (imageGuids.length === 0) {
      results.push({
        type: "Texture",
        name: `${name}_Texture`,
        guid: textureGuid,
        version: 1,
        dependencies: [],
        parentClass: null,
        payload: { compressionState: "pending", usage: "albedo" },
        chunks: [],
      });
      imageGuids.push(textureGuid);
    }
    const materialGuid = newAssetGuid();
    materialGuids.push(materialGuid);
    results.push({
      type: "Material",
      name: `${name}_Material`,
      guid: materialGuid,
      version: 1,
      dependencies: [textureGuid],
      parentClass: null,
      payload: {},
      chunks: [],
    });
  } else {
    for (const material of browse.materials) {
      const materialGuid = newAssetGuid();
      materialGuids.push(materialGuid);
      const dep =
        material.albedoImageIndex != null &&
        imageGuids[material.albedoImageIndex]
          ? [imageGuids[material.albedoImageIndex]!]
          : imageGuids[0]
            ? [imageGuids[0]]
            : [];
      results.push({
        type: "Material",
        name: `${name}_${material.name}`,
        guid: materialGuid,
        version: 1,
        dependencies: dep,
        parentClass: null,
        payload: {},
        chunks: [],
      });
    }
  }

  const animationGuids: string[] = [];
  const animations =
    browse.animations.length > 0
      ? browse.animations
      : [{ name: "Animation" }];
  for (const animation of animations) {
    const guid = newAssetGuid();
    animationGuids.push(guid);
    results.push({
      type: "Animation",
      name: `${name}_${animation.name}`,
      guid,
      version: 1,
      dependencies: [],
      parentClass: null,
      payload: {},
      chunks: [],
    });
  }

  const modelGuid = newAssetGuid();
  results.unshift({
    type: "Model",
    name,
    guid: modelGuid,
    version: 1,
    dependencies: [...materialGuids, ...animationGuids],
    parentClass: null,
    payload: {
      materialCount: materialGuids.length,
      textureCount: imageGuids.length,
      animationCount: animationGuids.length,
    },
    chunks: [{ id: "source", kind: "geometry", mime, data: bytes }],
  });

  return results;
}

function importStubDependents(
  name: string,
  mime: string,
  bytes: Uint8Array,
): ImportResult[] {
  const textureGuid = newAssetGuid();
  const materialGuid = newAssetGuid();
  const animationGuid = newAssetGuid();
  const modelGuid = newAssetGuid();

  return [
    {
      type: "Model",
      name,
      guid: modelGuid,
      version: 1,
      dependencies: [materialGuid, animationGuid],
      parentClass: null,
      payload: {},
      chunks: [{ id: "source", kind: "geometry", mime, data: bytes }],
    },
    {
      type: "Material",
      name: `${name}_Material`,
      guid: materialGuid,
      version: 1,
      dependencies: [textureGuid],
      parentClass: null,
      payload: {},
      chunks: [],
    },
    {
      type: "Texture",
      name: `${name}_Texture`,
      guid: textureGuid,
      version: 1,
      dependencies: [],
      parentClass: null,
      payload: { compressionState: "pending", usage: "albedo" },
      chunks: [],
    },
    {
      type: "Animation",
      name: `${name}_Animation`,
      guid: animationGuid,
      version: 1,
      dependencies: [],
      parentClass: null,
      payload: {},
      chunks: [],
    },
  ];
}
