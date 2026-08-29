import {
  Color3,
  Material,
  StandardMaterial,
  Texture,
  type AbstractMesh,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import type { SpriteAnimationPayload, SpritePayload, TilemapPayload, TilesetPayload, ModelPayload, RetargetAnimationLoad } from "@babylonslate/assets";
import type { ResourceCache } from "./resource-cache";

/** Bytes and payloads the editor / Play mesh builders use for authored content. */
export interface MeshAssetContext {
  resourceCache?: ResourceCache;
  textureBytes?: ReadonlyMap<string, Uint8Array | Blob>;
  /** Authored Texture payload width/height (source pixels), not LOD GPU bytes. */
  texturePixelSizes?: ReadonlyMap<string, { width: number; height: number }>;
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
  spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>;
  tilemaps?: ReadonlyMap<string, TilemapPayload>;
  tilesets?: ReadonlyMap<string, TilesetPayload>;
  modelBytes?: ReadonlyMap<string, Uint8Array>;
  modelPayloads?: ReadonlyMap<string, ModelPayload>;
  /**
   * Editor MeshComponent collision dashes. Session **Show Collisions**
   * (default off). 2D worlds and Play omit this (`showcollision` draws
   * physics debug instead).
   */
  drawMeshCollision?: boolean;
  /**
   * Texture guids sampled by each Material document (`materialDependencies`).
   * With `textureBytes`, GLB slim runs only when those guids are packed.
   */
  materialTextureGuids?: ReadonlyMap<string, readonly string[]>;
  /**
   * Material guids that compiled successfully in this Scene. GLB slim requires
   * this so a packed-but-unbound slot cannot stick on the 1×1 red stub.
   */
  compiledMaterialGuids?: ReadonlySet<string>;
  /** Native clipName → Animation guid, keyed by Model guid. */
  modelClipAnimationGuids?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Retargeted Animation loads keyed by the actor (target) Model guid. */
  retargetAnimationLoads?: ReadonlyMap<string, readonly RetargetAnimationLoad[]>;
  pixelsPerUnit?: number;
  /** Facetype JSON bytes keyed by Font asset guid (3D Text). */
  fontFacetypeBytes?: ReadonlyMap<string, Uint8Array>;
  /** MSDF bmfont JSON keyed by Font asset guid (overlay 2D Text). */
  fontMsdfJson?: ReadonlyMap<string, Uint8Array>;
  /** MSDF atlas PNG keyed by Font asset guid. */
  fontMsdfPng?: ReadonlyMap<string, Uint8Array>;
  /** CSS font stack when no Font is picked (project default + generic). */
  fontCssStack?: string;
  /** Per-Font compiled CSS stacks for Bitmap 2D Text. */
  fontCssStackByGuid?: ReadonlyMap<string, string>;
  /** Play pause — overlay letter effects freeze while true. */
  paused?: boolean;
  /** Compiled overlay / mesh Materials (2DMaterial, 2DPanel). */
  resolveMaterial?: (
    guid: string,
    options?: { scene?: Scene; unlit?: boolean },
  ) => Material | null;
}

function sortedMapKeys(map: ReadonlyMap<string, unknown> | undefined): string {
  if (!map || map.size === 0) return "";
  return [...map.keys()].sort().join(",");
}

function assetByteLength(bytes: Uint8Array | Blob): number {
  return bytes instanceof Uint8Array ? bytes.byteLength : bytes.size;
}

function byteMapFingerprint(
  map: ReadonlyMap<string, Uint8Array | Blob> | undefined,
): string {
  if (!map || map.size === 0) return "";
  return [...map.entries()]
    .map(([guid, bytes]) => `${guid}:${assetByteLength(bytes)}`)
    .sort()
    .join(",");
}

function sortedStringMapFingerprint(
  map: ReadonlyMap<string, string> | undefined,
): string {
  if (!map || map.size === 0) return "";
  return [...map.entries()]
    .map(([guid, value]) => `${guid}:${value}`)
    .sort()
    .join(",");
}

/**
 * Stable key for editor mesh rebuilds. Transform-only scene commits reuse the
 * same payloads (new Map instances), so identity of the maps must not matter.
 */
export function meshAssetFingerprint(
  assets: MeshAssetContext | undefined,
): string {
  if (!assets) return "";
  return [
    `ppu:${assets.pixelsPerUnit ?? ""}`,
    `sprites:${sortedMapKeys(assets.spritePayloads)}`,
    `spriteAnims:${sortedMapKeys(assets.spriteAnimations)}`,
    `tilemaps:${sortedMapKeys(assets.tilemaps)}`,
    `tilesets:${sortedMapKeys(assets.tilesets)}`,
    `tex:${byteMapFingerprint(assets.textureBytes)}`,
    `texPx:${
      assets.texturePixelSizes
        ? [...assets.texturePixelSizes.entries()]
            .map(([guid, size]) => `${guid}:${size.width}x${size.height}`)
            .sort()
            .join(",")
        : ""
    }`,
    `fonts:${byteMapFingerprint(assets.fontFacetypeBytes)}`,
    `msdf:${byteMapFingerprint(assets.fontMsdfJson)}:${byteMapFingerprint(assets.fontMsdfPng)}`,
    `fontCss:${assets.fontCssStack ?? ""}:${sortedStringMapFingerprint(assets.fontCssStackByGuid)}`,
    `models:${byteMapFingerprint(assets.modelBytes)}`,
  ].join("|");
}

export function meshAssetFingerprintWithoutModels(
  assets: MeshAssetContext | undefined,
): string {
  return meshAssetFingerprint({
    pixelsPerUnit: assets?.pixelsPerUnit,
    spritePayloads: assets?.spritePayloads,
    spriteAnimations: assets?.spriteAnimations,
    tilemaps: assets?.tilemaps,
    tilesets: assets?.tilesets,
    textureBytes: assets?.textureBytes,
    texturePixelSizes: assets?.texturePixelSizes,
    fontFacetypeBytes: assets?.fontFacetypeBytes,
    fontMsdfJson: assets?.fontMsdfJson,
    fontMsdfPng: assets?.fontMsdfPng,
    fontCssStack: assets?.fontCssStack,
    fontCssStackByGuid: assets?.fontCssStackByGuid,
    modelBytes: undefined,
  });
}

export function modelSlotFingerprint(
  payloads: ReadonlyMap<string, ModelPayload> | undefined,
): string {
  if (!payloads || payloads.size === 0) return "";
  return [...payloads.entries()]
    .map(([guid, payload]) => {
      const slots = payload.materialSlots
        .map((slot) => `${slot.index}=${slot.materialGuid ?? ""}`)
        .join(",");
      const colliders = JSON.stringify(payload.simpleColliders ?? []);
      return `${guid}:${slots}:${colliders}`;
    })
    .sort()
    .join(";");
}

export function applyAlbedoTexture(
  mesh: AbstractMesh,
  scene: Scene,
  textureGuid: string | null | undefined,
  assets?: MeshAssetContext,
): void {
  if (!textureGuid || !assets?.resourceCache || !assets.textureBytes) return;
  const bytes = assets.textureBytes.get(textureGuid);
  if (!bytes) return;
  const texture = assets.resourceCache.getTexture(
    textureGuid,
    scene.getEngine(),
    bytes,
    {
      noMipmap: true,
      samplingMode: Texture.NEAREST_SAMPLINGMODE,
    },
  );
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  const material = new StandardMaterial(`albedo:${textureGuid}`, scene);
  material.disableLighting = true;
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.emissiveColor = Color3.White();
  material.useAlphaFromDiffuseTexture = true;
  material.transparencyMode = Material.MATERIAL_ALPHATEST;
  material.alphaCutOff = 0.4;
  mesh.material = material;
}

/** Bind each tilemap chunk child to the atlas stored on `metadata.tilemapTextureGuid`. */
export function applyTilemapAlbedoTextures(
  mesh: Mesh,
  scene: Scene,
  assets?: MeshAssetContext,
): void {
  for (const child of mesh.getChildMeshes()) {
    const guid = child.metadata?.tilemapTextureGuid as string | null | undefined;
    applyAlbedoTexture(child, scene, guid, assets);
  }
}
