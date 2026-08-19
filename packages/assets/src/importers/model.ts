import { migrateLegacyShaderPayload } from "@babylonslate/shader-graph";
import { normalizeAnimationPayload } from "../animation-payload";
import { newAssetGuid } from "../guid";
import { MATERIAL_PAYLOAD_VERSION } from "../migration";
import { normalizeModelPayload } from "../model-payload";
import { normalizeSkeletonPayload } from "../skeleton-payload";
import { nextCopyName } from "../unique-names";
import type { ImportOptions, ImportResult } from "./types";
import { baseName, extensionOf } from "./util";
import {
  parseGlbForBrowse,
  parseGltfJsonForBrowse,
  type GlbBrowseParse,
} from "./glb-parse";

export const MODEL_EXTENSIONS = new Set(["glb", "gltf"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
};

const UNSUPPORTED_MODEL_FORMAT =
  "Models must be GLB or glTF. FBX, OBJ, STL, and other DCC formats are not supported.";

/**
 * Models import as a Model asset plus browsable Material / Texture / Animation
 * dependents. GLB/glTF parse enough of the container for CB headers and
 * embedded albedo images; mesh runtime fidelity can stay thin until Play.
 *
 * Imported materials are authored Material documents from the start, seeded
 * with the albedo texture, so opening one shows an editable graph rather than
 * an empty settings tab.
 */

/** Material document for an imported glTF material slot. */
function importedMaterialPayload(
  name: string,
  textureGuid: string | undefined,
  unlit: boolean,
): Record<string, unknown> {
  const document = migrateLegacyShaderPayload(
    { shadingModel: unlit ? "unlit" : "pbr" },
    { textureGuids: textureGuid ? [textureGuid] : [] },
  );
  return { ...document, name } as unknown as Record<string, unknown>;
}
export async function importModel(
  bytes: Uint8Array,
  options: ImportOptions,
): Promise<ImportResult[]> {
  const extension = extensionOf(options.fileName);
  if (!MODEL_EXTENSIONS.has(extension)) {
    throw new Error(UNSUPPORTED_MODEL_FORMAT);
  }
  const mime = MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
  const name = baseName(options.fileName);

  const browse =
    extension === "glb"
      ? parseGlbForBrowse(bytes)
      : parseGltfJsonForBrowse(new TextDecoder().decode(bytes));

  if (!browse) {
    throw new Error(UNSUPPORTED_MODEL_FORMAT);
  }
  return importFromBrowse(name, mime, bytes, browse);
}

function uniqueImportName(base: string, used: string[]): string {
  const name = nextCopyName(base, used);
  used.push(name);
  return name;
}

function importFromBrowse(
  name: string,
  mime: string,
  bytes: Uint8Array,
  browse: GlbBrowseParse,
): ImportResult[] {
  const results: ImportResult[] = [];
  const imageGuids: string[] = [];
  const usedNames: string[] = [name];

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
      name: uniqueImportName(`${name}_${image.name}`, usedNames),
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
        name: uniqueImportName(`${name}_Texture`, usedNames),
        guid: textureGuid,
        version: 1,
        dependencies: [],
        parentClass: null,
        payload: { compressionState: "pending", usage: "albedo" },
        chunks: [],
      });
      imageGuids.push(textureGuid);
    }
    const materialName = uniqueImportName(`${name}_Material`, usedNames);
    const materialGuid = newAssetGuid();
    materialGuids.push(materialGuid);
    results.push({
      type: "Material",
      name: materialName,
      guid: materialGuid,
      version: MATERIAL_PAYLOAD_VERSION,
      dependencies: [textureGuid],
      parentClass: null,
      payload: importedMaterialPayload(materialName, textureGuid, false),
      chunks: [],
    });
  } else {
    for (const [i, material] of browse.materials.entries()) {
      const materialGuid = newAssetGuid();
      materialGuids.push(materialGuid);
      const dep =
        material.albedoImageIndex != null &&
        imageGuids[material.albedoImageIndex]
          ? [imageGuids[material.albedoImageIndex]!]
          : imageGuids[0]
            ? [imageGuids[0]]
            : [];
      const materialName = uniqueImportName(
        `${name}_${material.name}`,
        usedNames,
      );
      results.push({
        type: "Material",
        name: materialName,
        guid: materialGuid,
        version: MATERIAL_PAYLOAD_VERSION,
        dependencies: dep,
        parentClass: null,
        // The slot index keeps model-to-material assignment stable across
        // re-imports even when material names change.
        payload: {
          ...importedMaterialPayload(materialName, dep[0], material.unlit),
          slotIndex: i,
        },
        chunks: [],
      });
    }
  }

  const modelGuid = newAssetGuid();
  const skeletonGuid = browse.rigKind === "none" ? null : newAssetGuid();
  if (skeletonGuid) {
    results.push({
      type: "Skeleton",
      name: uniqueImportName(`${name}_Skeleton`, usedNames),
      guid: skeletonGuid,
      version: 1,
      dependencies: [modelGuid],
      parentClass: null,
      payload: {
        ...normalizeSkeletonPayload({
          modelGuid,
          kind: browse.rigKind,
          boneNames: browse.boneNames,
        }),
      },
      chunks: [],
    });
  }

  const animationGuids: string[] = [];
  const animations = browse.animations;
  for (const animation of animations) {
    const guid = newAssetGuid();
    animationGuids.push(guid);
    results.push({
      type: "Animation",
      name: uniqueImportName(`${name}_${animation.name}`, usedNames),
      guid,
      version: 1,
      dependencies: [modelGuid, ...(skeletonGuid ? [skeletonGuid] : [])],
      parentClass: null,
      payload: {
        ...normalizeAnimationPayload({
          clipName: animation.name,
          modelGuid,
          skeletonGuid,
          durationMs: animation.durationMs,
        }),
      },
      chunks: [],
    });
  }

  const slotNames =
    browse.materials.length > 0
      ? browse.materials.map((material) => material.name)
      : materialGuids.map(() => "Material");

  results.unshift({
    type: "Model",
    name,
    guid: modelGuid,
    version: 1,
    dependencies: [
      ...materialGuids,
      ...animationGuids,
      ...(skeletonGuid ? [skeletonGuid] : []),
    ],
    parentClass: null,
    payload: {
      ...normalizeModelPayload({
        clipNames: animations.map((animation) => animation.name),
        materialSlots: materialGuids.map((guid, index) => ({
          index,
          name: slotNames[index],
          materialGuid: guid,
        })),
        skeletonGuid,
      }),
    } as Record<string, unknown>,
    chunks: [{ id: "source", kind: "geometry", mime, data: bytes }],
  });

  return results;
}
