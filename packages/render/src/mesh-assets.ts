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
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
  spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>;
  tilemaps?: ReadonlyMap<string, TilemapPayload>;
  tilesets?: ReadonlyMap<string, TilesetPayload>;
  modelBytes?: ReadonlyMap<string, Uint8Array>;
  modelPayloads?: ReadonlyMap<string, ModelPayload>;
  /** Native clipName → Animation guid, keyed by Model guid. */
  modelClipAnimationGuids?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** Retargeted Animation loads keyed by the actor (target) Model guid. */
  retargetAnimationLoads?: ReadonlyMap<string, readonly RetargetAnimationLoad[]>;
  pixelsPerUnit?: number;
  /** Facetype JSON bytes keyed by Font asset guid (3D Text). */
  fontFacetypeBytes?: ReadonlyMap<string, Uint8Array>;
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
    `fonts:${byteMapFingerprint(assets.fontFacetypeBytes)}`,
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
      return `${guid}:${slots}`;
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
  const material = new StandardMaterial(`albedo:${textureGuid}`, scene);
  material.disableLighting = true;
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.emissiveColor = Color3.White();
  texture.hasAlpha = true;
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
