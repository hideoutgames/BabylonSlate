import {
  Color3,
  ImageProcessingConfiguration,
  Material,
  StandardMaterial,
  type AbstractMesh,
  type Mesh,
  type Scene,
  type Texture,
  type CubeTexture,
} from "@babylonjs/core";
import type { SpriteAnimationPayload, SpritePayload, TilemapPayload, TilesetPayload, ModelPayload, RetargetAnimationLoad } from "@babylonslate/assets";
import { PIXEL_ART_TEXTURE_SAMPLING, type TextureResources, type ResourceLease } from "./resource-cache";
import { isSpriteQuad } from "./sprite-quad";
import { applyMaterialBounds } from "./material-bounds";
import { markSceneReadinessDirty } from "./scene-perf";

/** Bytes and payloads the editor / Play mesh builders use for authored content. */
export interface MeshAssetContext {
  resourceCache?: TextureResources;
  textureBytes?: ReadonlyMap<string, Uint8Array | Blob>;
  /** Authored Texture payload width/height (source pixels), not LOD GPU bytes. */
  texturePixelSizes?: ReadonlyMap<string, { width: number; height: number }>;
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
  spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>;
  tilemaps?: ReadonlyMap<string, TilemapPayload>;
  tilesets?: ReadonlyMap<string, TilesetPayload>;
  modelBytes?: ReadonlyMap<string, Uint8Array>;
  /** Immutable installed content used by scene-local decoded model generations. */
  modelSources?: ReadonlyMap<string, Blob>;
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
  sortingLayers?: readonly string[];
  /** Facetype JSON bytes keyed by Font asset guid (3D Text). */
  fontFacetypeBytes?: ReadonlyMap<string, Uint8Array>;
  /** MSDF bmfont JSON keyed by Font asset guid (overlay 2D Text). */
  fontMsdfJson?: ReadonlyMap<string, Uint8Array>;
  /** MSDF atlas PNG keyed by Font asset guid. */
  fontMsdfPng?: ReadonlyMap<string, Uint8Array | Blob>;
  /** CSS font stack when no Font is picked (project default + generic). */
  fontCssStack?: string;
  /** Per-Font compiled CSS stacks for Bitmap 2D Text. */
  fontCssStackByGuid?: ReadonlyMap<string, string>;
  /** Play pause — overlay letter effects freeze while true. */
  paused?: boolean;
  /** Existing bitmap storage retained while a replacement visual is staged. */
  retainedTextBitmapBytes?: number;
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

function payloadMapFingerprint(map: ReadonlyMap<string, unknown> | undefined): string {
  if (!map || map.size === 0) return "";
  return JSON.stringify([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

import { environmentTextureContainer, installAssetBytes, isKtx2Bytes } from "@babylonslate/assets";
import { isDisposedGpuTexture } from "./gpu-resource-live";
import { snapshotByteFingerprint } from "./asset-byte-fingerprint";

export function installModelSources(assets: Pick<MeshAssetContext, "modelBytes" | "modelSources">): ReadonlyMap<string, Blob> | undefined {
  if (assets.modelSources) return assets.modelSources;
  if (!assets.modelBytes) return undefined;
  return new Map([...assets.modelBytes].map(([guid, bytes]) => [guid, installAssetBytes(bytes, "model/gltf-binary")]));
}

function byteMapFingerprint(
  map: ReadonlyMap<string, Uint8Array | Blob> | undefined,
): string {
  if (!map || map.size === 0) return "";
  return [...map.entries()]
    .map(([guid, bytes]) => `${guid}:${snapshotByteFingerprint(bytes)}`)
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
    `tilemaps:${payloadMapFingerprint(assets.tilemaps)}`,
    `tilesets:${payloadMapFingerprint(assets.tilesets)}`,
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
    `models:${byteMapFingerprint(assets.modelSources ?? assets.modelBytes)}`,
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

/** Copy mutable bytes once at asset installation; resource lookups use immutable identities. */
export function installTextureBytes(bytes: ReadonlyMap<string, Uint8Array | Blob> | undefined): ReadonlyMap<string, Blob> | undefined {
  if (!bytes) return undefined;
  return new Map([...bytes].map(([guid, source]) => {
    const kind = source instanceof Uint8Array ? environmentTextureContainer(source) : null;
    const mime = kind === "env" ? "application/vnd.babylon.env" : kind === "dds" ? "image/vnd-ms.dds"
      : source instanceof Uint8Array && isKtx2Bytes(source) ? "image/ktx2" : "application/octet-stream";
    return [guid, installAssetBytes(source, mime)];
  }));
}

interface AlbedoBinding {
  material: StandardMaterial | null;
  lease?: ResourceLease<Texture | CubeTexture>;
  source?: Uint8Array | Blob;
  guid?: string;
  identity?: string;
  failed?: string;
  pending?: ResourceLease<Texture | CubeTexture>;
  cancel?: () => void;
}
const albedoBindings = new WeakMap<AbstractMesh, AlbedoBinding>();

function syncAlbedoTransparency(mesh: AbstractMesh, material: StandardMaterial): void {
  const mode = mesh.visibility > 0 && mesh.visibility < 1
    ? Material.MATERIAL_ALPHATESTANDBLEND
    : Material.MATERIAL_ALPHATEST;
  if (material.transparencyMode === mode) return;
  material.transparencyMode = mode;
  // Babylon's material setter dirties local shader defines but emits none of
  // the scene observables used by the strict readiness cache.
  markSceneReadinessDirty(mesh.getScene());
}

/** Weight changes preserve owned cutouts while opting fractional weights into blending. */
export function applySpriteVisibility(mesh: AbstractMesh, visibility: number): void {
  const material = mesh.material;
  const owned = albedoBindings.get(mesh)?.material;
  const blended = material?.needAlphaBlendingForMesh(mesh);
  mesh.visibility = visibility;
  if (owned && material === owned) {
    syncAlbedoTransparency(mesh, owned);
  } else if (material && blended !== material.needAlphaBlendingForMesh(mesh)) {
    // Authored materials retain their own alpha policy, including automatic mode.
    markSceneReadinessDirty(mesh.getScene());
  }
}

/** Restore the mesh's owned construction material after a borrowed assignment clears. */
export function restoreAlbedoMaterial(mesh: AbstractMesh): boolean {
  const material = albedoBindings.get(mesh)?.material;
  if (!material) return false;
  mesh.material = material;
  applyMaterialBounds(mesh);
  syncAlbedoTransparency(mesh, material);
  return true;
}

export function applyAlbedoTexture(
  mesh: AbstractMesh,
  _scene: Scene,
  textureGuid: string | null | undefined,
  assets?: MeshAssetContext,
): void {
  const scene = mesh.getScene();
  let binding = albedoBindings.get(mesh);
  if (!binding) {
    binding = { material: null };
    albedoBindings.set(mesh, binding);
    mesh.onDisposeObservable.addOnce(() => {
      binding!.cancel?.();
      binding!.pending?.release();
      binding!.material?.dispose(false, false);
      binding!.lease?.release();
      albedoBindings.delete(mesh);
    });
  }
  if (!textureGuid) {
    binding.cancel?.(); binding.cancel = undefined;
    binding.pending?.release(); binding.pending = undefined;
    binding.lease?.release(); binding.lease = undefined;
    if (binding.material) { binding.material.diffuseTexture = null; binding.material.emissiveTexture = null; }
    binding.source = undefined; binding.guid = undefined; binding.identity = undefined; binding.failed = undefined;
    return;
  }
  // An authored material owns its own texture contract. Keep the construction
  // material and its exact lease alive so clearing the override can restore it.
  if (mesh.material && mesh.material !== binding.material && (binding.material || isSpriteQuad(mesh))) {
    return;
  }
  if (!mesh.material && binding.material) restoreAlbedoMaterial(mesh);
  const source = assets?.textureBytes?.get(textureGuid);
  if (!source || !assets?.resourceCache) return;
  const identity = source instanceof Blob && binding.source === source ? binding.identity : snapshotByteFingerprint(source);
  if (binding.identity === identity && binding.guid === textureGuid &&
    ((binding.lease && !isDisposedGpuTexture(binding.lease.resource)) || binding.pending)) { binding.source = source; return; }
  if (binding.failed === `${textureGuid}:${identity}`) return;
  let next: ResourceLease<Texture | CubeTexture>;
  try { next = assets.resourceCache.acquireTexture(textureGuid, scene.getEngine(), source, { ...PIXEL_ART_TEXTURE_SAMPLING, hasAlpha: true }); }
  catch (error) { binding.failed = `${textureGuid}:${identity}`; console.error("Sprite texture replacement failed", error); return; }
  binding.cancel?.(); binding.pending?.release();
  binding.source = source; binding.guid = textureGuid; binding.identity = identity;
  binding.pending = next;
  const publish = () => {
    if (albedoBindings.get(mesh) !== binding || binding.pending !== next || mesh.isDisposed()) { next.release(); return; }
    binding.cancel?.(); binding.cancel = undefined;
    const publishToMesh = !mesh.material || mesh.material === binding.material || (!binding.material && !isSpriteQuad(mesh));
    let material = binding.material;
    if (!material) {
      material = new StandardMaterial(`albedo:${textureGuid}`, scene);
      material.disableLighting = true;
      material.emissiveColor = Color3.White();
      material.useAlphaFromDiffuseTexture = true;
      material.transparencyMode = Material.MATERIAL_ALPHATEST;
      material.alphaCutOff = 0.4;
      binding.material = material;
    }
    material.diffuseTexture = next.resource;
    material.emissiveTexture = next.resource;
    // Preparation may finish after an authored assignment. Update only our
    // retained material in that case; the borrowed material remains attached.
    if (publishToMesh) {
      mesh.material = material;
      syncAlbedoTransparency(mesh, material);
    }
    const previous = binding.lease;
    binding.lease = next; binding.pending = undefined;
    previous?.release();
  };
  const failed = (error: unknown) => {
    if (albedoBindings.get(mesh) !== binding || (binding.pending !== next && binding.lease !== next)) return;
    if (binding.pending === next) binding.pending = undefined;
    if (binding.lease === next) {
      binding.lease = undefined;
      if (binding.material) { binding.material.diffuseTexture = null; binding.material.emissiveTexture = null; }
    }
    binding.failed = `${textureGuid}:${identity}`;
    next.release();
    console.error("Sprite texture replacement failed", error);
  };
  if (!binding.lease || next.resource.isReady()) {
    publish();
    void next.ready?.catch(failed);
  } else if (next.ready) void next.ready.then(publish, failed);

}

/** Bind each tilemap chunk child to the atlas stored on `metadata.tilemapTextureGuid`. */
export function applyTilemapAlbedoTextures(
  mesh: Mesh,
  scene: Scene,
  assets?: MeshAssetContext,
): void {
  const imageProcessing = new ImageProcessingConfiguration();
  imageProcessing.isEnabled = false;
  for (const child of mesh.getChildMeshes()) {
    const guid = child.metadata?.tilemapTextureGuid as string | null | undefined;
    const before = child.material;
    applyAlbedoTexture(child, scene, guid, assets);
    const material = child.material;
    if (material === before || !(material instanceof StandardMaterial)) continue;
    // Tilemaps remain readable from either side, including inside 3D actors.
    material.backFaceCulling = false;
    material.fogEnabled = false;
    material.imageProcessingConfiguration = imageProcessing;
  }
}
