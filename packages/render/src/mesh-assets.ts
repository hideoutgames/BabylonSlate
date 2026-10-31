import { pooledLeafOf, setActorMeshMaterial } from "./pooled-visuals";
import {
  type AbstractMesh,
  type Material,
  type NodeMaterial,
  type Mesh,
  type Scene,
  type Texture,
  type CubeTexture,
} from "@babylonjs/core";
import type { SpriteAnimationPayload, SpritePayload, TilemapPayload, TilesetPayload, ModelPayload, RetargetAnimationLoad, AreaEmissionPixels } from "@haptic/assets";
import { PIXEL_ART_TEXTURE_SAMPLING, type TextureResources, type ResourceLease } from "./resource-cache";
import { isSpriteQuad } from "./sprite-quad";
import { applyMaterialBounds } from "./material-bounds";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { skyboxMeshPreparation } from "./skybox";
import { foliagePreparation } from "./foliage-mesh";
import { authoredMaterialInstancePreparation } from "./authored-material-instance";
import { setUnlitMaterial, unlitMaterial, type UnlitBinding, type UnlitMaterialKey } from "./unlit-material";

/** Bytes and payloads the editor / Play mesh builders use for authored content. */
export interface MeshAssetContext {
  renderTargets?: ReadonlyMap<string, import("@haptic/core").RenderTargetPayload>;
  renderTargetTextures?: ReadonlyMap<string, import("@haptic/core").RenderTargetTexturePayload>;
  waters?: ReadonlyMap<string, import("@haptic/core").WaterDefinition>;
  resourceCache?: TextureResources;
  textureBytes?: ReadonlyMap<string, Uint8Array | Blob>;
  /** Validated native emission data, separate from original Texture bytes. */
  areaEmissions?: ReadonlyMap<string, AreaEmissionPixels>;
  /** Authored Texture payload width/height (source pixels), not LOD GPU bytes. */
  texturePixelSizes?: ReadonlyMap<string, { width: number; height: number }>;
  spritePayloads?: ReadonlyMap<string, SpritePayload>;
  spriteAnimations?: ReadonlyMap<string, SpriteAnimationPayload>;
  tilemaps?: ReadonlyMap<string, TilemapPayload>;
  tilesets?: ReadonlyMap<string, TilesetPayload>;
  /**
   * A revision per Tilemap, Tileset and Water guid: a payload whose revision is
   * unchanged is unchanged, however many times a host re-read or re-normalized
   * it. The editor remembers the serialized form of each by revision rather than
   * serializing every payload to compare installs. A guid without a revision is
   * serialized every time.
   */
  payloadRevisions?: ReadonlyMap<string, string>;
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
    options?: import("./material-library").MaterialResolveOptions & { scene?: Scene },
  ) => Material | null;
  /** Releases private component overrides without retiring shared authored materials. */
  releaseMaterialInstance?: (instanceKey: string, assetGuid?: string) => void;
  validateMaterialParameter?: (guid: string, name: string, value: import("@haptic/core").MaterialParameterValue) => boolean;
}

function sortedMapKeys(map: ReadonlyMap<string, unknown> | undefined): string {
  if (!map || map.size === 0) return "";
  return [...map.keys()].sort().join(",");
}

function payloadMapFingerprint(map: ReadonlyMap<string, unknown> | undefined): string {
  if (!map || map.size === 0) return "";
  return JSON.stringify([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

type PayloadKind = "tilemaps" | "waters" | "tilesets";

/**
 * `payloadMapFingerprint` that remembers each payload's serialized form under
 * the revision the host reported for it (`MeshAssetContext.payloadRevisions`),
 * so a payload whose revision is unchanged is not serialized again. Only the
 * payloads of the latest call are kept. The strings it returns are exactly
 * `payloadMapFingerprint`'s: that is `JSON.stringify` of the sorted
 * `[guid, payload]` entries, whose array is the entries' own serializations
 * joined by commas.
 */
export class PayloadFingerprints {
  private readonly remembered = new Map<PayloadKind, Map<string, { revision: string; json: string }>>();

  fingerprint(
    kind: PayloadKind,
    map: ReadonlyMap<string, unknown> | undefined,
    revisions: ReadonlyMap<string, string> | undefined,
  ): string {
    if (!map || map.size === 0) {
      this.remembered.delete(kind);
      return "";
    }
    const before = this.remembered.get(kind);
    const after = new Map<string, { revision: string; json: string }>();
    const entries = [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([guid, payload]) => {
      const revision = revisions?.get(guid);
      const known = revision === undefined ? undefined : before?.get(guid);
      const json = known && known.revision === revision ? known.json : JSON.stringify([guid, payload]);
      if (revision !== undefined) after.set(guid, { revision, json });
      return json;
    });
    this.remembered.set(kind, after);
    return `[${entries.join(",")}]`;
  }
}

import { copyTextureBytesForUpload, environmentTextureContainer, installAssetBytes, isKtx2Bytes } from "@haptic/assets";
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
 * Key of the inputs whose change rebuilds editor meshes: everything except
 * Model bytes and area-light emission, which reapply in place. With `payloads`,
 * a Tilemap, Tileset or Water whose revision (`payloadRevisions`) is unchanged
 * since the last call with it is not serialized again; the key is the same.
 */
export function meshAssetFingerprintWithoutModels(
  assets: MeshAssetContext | undefined,
  payloads?: PayloadFingerprints,
): string {
  const payloadFingerprint = (kind: PayloadKind, map: ReadonlyMap<string, unknown> | undefined) =>
    payloads ? payloads.fingerprint(kind, map, assets?.payloadRevisions) : payloadMapFingerprint(map);
  return [
    `ppu:${assets?.pixelsPerUnit ?? ""}`,
    `sprites:${sortedMapKeys(assets?.spritePayloads)}`,
    `spriteAnims:${sortedMapKeys(assets?.spriteAnimations)}`,
    `tilemaps:${payloadFingerprint("tilemaps", assets?.tilemaps)}`,
    `waters:${payloadFingerprint("waters", assets?.waters)}`,
    `tilesets:${payloadFingerprint("tilesets", assets?.tilesets)}`,
    `tex:${byteMapFingerprint(assets?.textureBytes)}`,
    `texPx:${
      assets?.texturePixelSizes
        ? [...assets.texturePixelSizes.entries()]
            .map(([guid, size]) => `${guid}:${size.width}x${size.height}`)
            .sort()
            .join(",")
        : ""
    }`,
    `fonts:${byteMapFingerprint(assets?.fontFacetypeBytes)}`,
    `msdf:${byteMapFingerprint(assets?.fontMsdfJson)}:${byteMapFingerprint(assets?.fontMsdfPng)}`,
    `fontCss:${assets?.fontCssStack ?? ""}:${sortedStringMapFingerprint(assets?.fontCssStackByGuid)}`,
  ].join("|");
}

/**
 * Stable key for editor mesh rebuilds. Transform-only scene commits reuse the
 * same payloads (new Map instances), so identity of the maps must not matter.
 * Pass the caller's `meshAssetFingerprintWithoutModels` result to avoid
 * serializing the tilemap, tileset and water payloads a second time.
 */
export function meshAssetFingerprint(
  assets: MeshAssetContext | undefined,
  withoutModels = meshAssetFingerprintWithoutModels(assets),
): string {
  if (!assets) return "";
  return [
    withoutModels,
    `area:${[...(assets.areaEmissions ?? [])].map(([guid, data]) => `${guid}:${data.metadata.pixelsHash}`).sort().join(",")}`,
    `models:${byteMapFingerprint(assets.modelSources ?? assets.modelBytes)}`,
  ].join("|");
}

/** A number per installed map (or other object value), keyed weakly: a revision compares identities and keeps none. */
const installedIdentities = new WeakMap<object, number>();
let lastInstalledIdentity = 0;
/** Each context's install revision, with the identities of what it held when that revision was taken. */
const installRevisions = new WeakMap<MeshAssetContext, { key: string; revision: number }>();

/**
 * The revision of the installed assets `meshAssetFingerprint` hashes, as `assets` holds them now. An install replaces
 * these maps and values rather than editing them, so the revision moves on whenever one was replaced since the last
 * call, and an equal revision means the same maps, without hashing any bytes or holding any map: a record of what a
 * visual was built with keeps the number, never the superseded bytes (a scene's sources released since).
 */
export function meshAssetInstallRevision(assets: MeshAssetContext): number {
  const key = [
    assets.pixelsPerUnit, assets.spritePayloads, assets.spriteAnimations, assets.tilemaps, assets.waters, assets.tilesets,
    assets.payloadRevisions, assets.textureBytes, assets.texturePixelSizes, assets.fontFacetypeBytes, assets.fontMsdfJson,
    assets.fontMsdfPng, assets.fontCssStack, assets.fontCssStackByGuid, assets.areaEmissions, assets.modelSources ?? assets.modelBytes,
  ].map((value) => {
    if (typeof value !== "object" || value === null) return `${typeof value}:${String(value)}`;
    let identity = installedIdentities.get(value);
    if (identity === undefined) installedIdentities.set(value, (identity = ++lastInstalledIdentity));
    return `#${identity}`;
  }).join("|");
  const last = installRevisions.get(assets);
  if (last?.key === key) return last.revision;
  const revision = (last?.revision ?? 0) + 1;
  installRevisions.set(assets, { key, revision });
  return revision;
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
      return `${guid}:${payload.importScale}:${payload.autoLod}:${slots}:${colliders}`;
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
    // Blob uploads bypass the native array-buffer path. Preserve its legacy
    // UASTC descriptor normalization before installing the immutable source.
    const upload = source instanceof Uint8Array && isKtx2Bytes(source)
      ? copyTextureBytesForUpload(source) : source;
    return [guid, installAssetBytes(upload, mime)];
  }));
}

interface AlbedoBinding {
  /** The unlit Material the mesh draws its texture with, once published; an authored assignment draws in its place. */
  material: NodeMaterial | null;
  /** The mesh's unlit key: a sprite's, or a tilemap chunk's (both sides, no fog, the atlas's image processing). */
  key: UnlitMaterialKey;
  /** What the unlit Material samples for the mesh. */
  unlit: UnlitBinding;
  /** Smooth alpha animation must not discard pixels below the cutout threshold. */
  alwaysBlend?: boolean;
  lease?: ResourceLease<Texture | CubeTexture>;
  source?: Uint8Array | Blob;
  guid?: string;
  identity?: string;
  failed?: string;
  pending?: ResourceLease<Texture | CubeTexture>;
  preparation?: Promise<void>;
}
const albedoBindings = new WeakMap<AbstractMesh, AlbedoBinding>();

/** Construction-time readiness for owned sprite/tilemap and skybox textures only. */
export function ownedVisualTexturePreparation(root: AbstractMesh): Promise<void> | undefined {
  const pending: Promise<void>[] = [];
  for (const mesh of [root, ...root.getChildMeshes()]) {
    const foliage = foliagePreparation(mesh as Mesh);
    if (foliage) pending.push(foliage);
    const materialInstance = authoredMaterialInstancePreparation(mesh as Mesh);
    if (materialInstance) pending.push(materialInstance);
    const binding = albedoBindings.get(mesh);
    const albedo = binding?.preparation;
    const skybox = skyboxMeshPreparation(mesh);
    if (albedo) pending.push(albedo);
    if (skybox) pending.push(skybox);
  }
  return pending.length ? Promise.all(pending).then(() => undefined) : undefined;
}

/**
 * Draws `mesh` with its albedo binding. A pooled visual's leaf cannot draw a per-mesh binding, so it leaves the pool
 * for a mesh of its own under the visual, which draws the visual's binding.
 */
function drawAlbedo(mesh: AbstractMesh, binding: AlbedoBinding): NodeMaterial {
  const material = setUnlitMaterial(mesh, binding.key, binding.unlit);
  if (pooledLeafOf(mesh)) {
    const own = setActorMeshMaterial(mesh, material);
    if (own) applyMaterialBounds(own);
  }
  return material;
}

/** A sprite's key: alpha-tested (blended while it fades), culled, fogged. */
const SPRITE_MATERIAL: UnlitMaterialKey = { textured: true, backFaceCulling: true, fog: true, role: "world" };
/** A tilemap chunk's: readable from either side, without fog, in the atlas's exact display colours. */
const TILEMAP_MATERIAL: UnlitMaterialKey = { textured: true, backFaceCulling: false, fog: false, role: "world", imageProcessing: "atlas" };

/**
 * The sprite's cutout: discarded below 0.4, unless it always blends (smooth alpha animation). A fractional visibility
 * blends the cutout (Standard's alpha test and blend), which the unlit Material decides per draw.
 */
function albedoUnlitBinding(texture: Texture | CubeTexture | null, alwaysBlend: boolean | undefined): UnlitBinding {
  return {
    texture, color: [1, 1, 1], alpha: 1, cutoff: alwaysBlend ? 0 : 0.4, blend: alwaysBlend === true, textureAlpha: true, twoSided: false,
  };
}

/** Weight changes preserve owned cutouts while opting fractional weights into blending. */
export function applySpriteVisibility(mesh: AbstractMesh, visibility: number): void {
  const material = mesh.material;
  const blended = material?.needAlphaBlendingForMesh(mesh);
  mesh.visibility = visibility;
  // The draw moves between the opaque and transparent lists; no shader changes.
  if (material && blended !== material.needAlphaBlendingForMesh(mesh)) markSceneReadinessDirty(mesh.getScene());
}

/** Restore the mesh's owned construction material after a borrowed assignment clears. */
export function restoreAlbedoMaterial(mesh: AbstractMesh): boolean {
  const binding = albedoBindings.get(mesh);
  if (!binding?.material) return false;
  binding.material = drawAlbedo(mesh, binding);
  applyMaterialBounds(mesh);
  return true;
}

export function applyAlbedoTexture(
  mesh: AbstractMesh,
  _scene: Scene,
  textureGuid: string | null | undefined,
  assets?: MeshAssetContext,
  options: { alwaysBlend?: boolean; tilemap?: boolean } = {},
): void {
  const scene = mesh.getScene();
  let binding = albedoBindings.get(mesh);
  if (!binding) {
    binding = { material: null, key: SPRITE_MATERIAL, unlit: albedoUnlitBinding(null, false) };
    albedoBindings.set(mesh, binding);
    mesh.onDisposeObservable.addOnce(() => {
      binding!.pending?.release();
      binding!.lease?.release();
      albedoBindings.delete(mesh);
    });
  }
  binding.alwaysBlend = options.alwaysBlend === true;
  if (options.tilemap) binding.key = TILEMAP_MATERIAL;
  /** Rebinds the mesh's unlit values: its draw when it draws them, otherwise only the values a restore reapplies. */
  const rebind = (texture: Texture | CubeTexture | null) => {
    binding!.unlit = albedoUnlitBinding(texture, binding!.alwaysBlend);
    if (binding!.material && mesh.material === binding!.material) binding!.material = setUnlitMaterial(mesh, binding!.key, binding!.unlit);
  };
  if (binding.unlit.blend !== binding.alwaysBlend) rebind(binding.unlit.texture as Texture | CubeTexture | null);
  if (!textureGuid) {
    binding.pending?.release(); binding.pending = undefined;
    binding.preparation = undefined;
    binding.lease?.release(); binding.lease = undefined;
    if (binding.material) rebind(null);
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
  catch (error) {
    binding.failed = `${textureGuid}:${identity}`;
    binding.preparation = Promise.reject(error);
    void binding.preparation.catch(() => {});
    console.error("Sprite texture replacement failed", error);
    return;
  }
  binding.pending?.release();
  binding.source = source; binding.guid = textureGuid; binding.identity = identity;
  binding.pending = next;
  binding.preparation = next.ready;
  const publish = () => {
    if (albedoBindings.get(mesh) !== binding || binding.pending !== next || mesh.isDisposed()) { next.release(); return; }
    const publishToMesh = !mesh.material || mesh.material === binding.material || (!binding.material && !isSpriteQuad(mesh));
    binding.unlit = albedoUnlitBinding(next.resource, binding.alwaysBlend);
    // Preparation may finish after an authored assignment. Update only our
    // retained binding in that case; the borrowed material remains attached.
    // Otherwise the borrowed material keeps drawing; `restoreAlbedoMaterial` reapplies these values.
    binding.material = publishToMesh ? drawAlbedo(mesh, binding) : unlitMaterial(scene, binding.key);
    const previous = binding.lease;
    binding.lease = next; binding.pending = undefined;
    previous?.release();
  };
  const failed = (error: unknown) => {
    if (albedoBindings.get(mesh) !== binding || (binding.pending !== next && binding.lease !== next)) return;
    if (binding.pending === next) binding.pending = undefined;
    if (binding.lease === next) {
      binding.lease = undefined;
      if (binding.material) rebind(null);
    }
    binding.failed = `${textureGuid}:${identity}`;
    next.release();
    console.error("Sprite texture replacement failed", error);
  };
  if (!binding.lease) {
    publish();
    void next.ready?.catch(failed);
  } else if (next.ready) {
    // Native readiness can precede asynchronous byte accounting/admission.
    // Keep the working lease until the complete successor preparation succeeds.
    void next.ready.then(publish, failed);
  } else if (next.resource.isReady()) publish();

}

/**
 * Point the owned albedo bindings under `root` at the current bytes of Textures
 * whose stored encoding changed (PNG to KTX2). Each binding takes a successor
 * lease that replaces the working one only once it is ready, so a failed upload
 * leaves the visual as it was. Returns the successor preparations.
 */
export function refreshAlbedoTextures(
  root: AbstractMesh,
  assets: MeshAssetContext,
  changed: ReadonlySet<string>,
): Promise<void>[] {
  const pending: Promise<void>[] = [];
  for (const mesh of [root, ...root.getChildMeshes()]) {
    const binding = albedoBindings.get(mesh);
    if (!binding?.guid || !changed.has(binding.guid)) continue;
    const before = binding.preparation;
    applyAlbedoTexture(mesh, mesh.getScene(), binding.guid, assets, { alwaysBlend: binding.alwaysBlend, tilemap: binding.key === TILEMAP_MATERIAL });
    if (binding.preparation && binding.preparation !== before) pending.push(binding.preparation);
  }
  return pending;
}

/** A chunk of an atlas without an image draws its tiles' placeholder colours, from its vertex colours. */
const TILEMAP_PLACEHOLDER: UnlitMaterialKey = { textured: false, backFaceCulling: false, fog: false, role: "world", imageProcessing: "atlas" };

/** Bind each tilemap chunk child to the atlas stored on `metadata.tilemapTextureGuid`. */
export function applyTilemapAlbedoTextures(
  mesh: Mesh,
  scene: Scene,
  assets?: MeshAssetContext,
): void {
  for (const child of mesh.getChildMeshes()) {
    const guid = child.metadata?.tilemapTextureGuid as string | null | undefined;
    if (!guid) {
      // Without an atlas image Babylon's lit default material would draw the
      // chunk black or grey; its vertex colours carry each tile's placeholder.
      setUnlitMaterial(child, TILEMAP_PLACEHOLDER, {
        texture: null, color: [1, 1, 1], alpha: 1, cutoff: 0, blend: false, textureAlpha: false, twoSided: false,
      });
      continue;
    }
    // Tilemaps remain readable from either side, including inside 3D actors.
    applyAlbedoTexture(child, scene, guid, assets, { tilemap: true });
  }
}
