import { enableOverlayVisualMaterial } from "./overlay-visual-style";
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
import type { IImageProcessingConfigurationDefines } from "@babylonjs/core/Materials/imageProcessingConfiguration.defines";
import type { SpriteAnimationPayload, SpritePayload, TilemapPayload, TilesetPayload, ModelPayload, RetargetAnimationLoad, AreaEmissionPixels } from "@babylonslate/assets";
import { PIXEL_ART_TEXTURE_SAMPLING, type TextureResources, type ResourceLease } from "./resource-cache";
import { isSpriteQuad } from "./sprite-quad";
import { applyMaterialBounds } from "./material-bounds";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { skyboxMeshPreparation } from "./skybox";
import { foliagePreparation } from "./foliage-mesh";
import { authoredMaterialInstancePreparation } from "./authored-material-instance";

/** Bytes and payloads the editor / Play mesh builders use for authored content. */
export interface MeshAssetContext {
  renderTargets?: ReadonlyMap<string, import("@babylonslate/core").RenderTargetPayload>;
  renderTargetTextures?: ReadonlyMap<string, import("@babylonslate/core").RenderTargetTexturePayload>;
  waters?: ReadonlyMap<string, import("@babylonslate/core").WaterDefinition>;
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
    options?: import("./material-library").MaterialResolveOptions & { scene?: Scene },
  ) => Material | null;
  /** Releases private component overrides without retiring shared authored materials. */
  releaseMaterialInstance?: (instanceKey: string, assetGuid?: string) => void;
  validateMaterialParameter?: (guid: string, name: string, value: import("@babylonslate/core").MaterialParameterValue) => boolean;
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

import { copyTextureBytesForUpload, environmentTextureContainer, installAssetBytes, isKtx2Bytes } from "@babylonslate/assets";
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
  material: StandardMaterial | null;
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

function syncAlbedoTransparency(mesh: AbstractMesh, material: StandardMaterial): void {
  const mode = albedoBindings.get(mesh)?.alwaysBlend ? Material.MATERIAL_ALPHABLEND : mesh.visibility > 0 && mesh.visibility < 1
    ? Material.MATERIAL_ALPHATESTANDBLEND
    : Material.MATERIAL_ALPHATEST;
  if (material.transparencyMode === mode) return;
  material.transparencyMode = mode;
  // Babylon's material setter dirties local shader defines but emits none of
  // the scene observables used by the strict readiness cache.
  markSceneReadinessDirty(mesh.getScene());
}

/** Whether Babylon's StandardMaterial reads this texture straight from the UVs (an identity texture matrix). */
function usesDirectUv(texture: Texture | CubeTexture): boolean {
  return texture.getTextureMatrix().isIdentityAs3x2();
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
  options: { alwaysBlend?: boolean } = {},
): void {
  const scene = mesh.getScene();
  let binding = albedoBindings.get(mesh);
  if (!binding) {
    binding = { material: null };
    albedoBindings.set(mesh, binding);
    mesh.onDisposeObservable.addOnce(() => {
      binding!.pending?.release();
      binding!.material?.dispose(false, false);
      binding!.lease?.release();
      albedoBindings.delete(mesh);
    });
  }
  binding.alwaysBlend = options.alwaysBlend === true;
  if (!textureGuid) {
    binding.pending?.release(); binding.pending = undefined;
    binding.preparation = undefined;
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
    const replaced = binding.lease?.resource;
    material.diffuseTexture = next.resource;
    material.emissiveTexture = next.resource;
    // Preparation may finish after an authored assignment. Update only our
    // retained material in that case; the borrowed material remains attached.
    if (publishToMesh) {
      mesh.material = material;
      enableOverlayVisualMaterial(mesh);
      syncAlbedoTransparency(mesh, material);
      // Babylon samples a texture with an identity matrix straight from the UVs
      // (DIFFUSEDIRECTUV / EMISSIVEDIRECTUV) and any other through the matrix, a
      // different shader. A KTX2 is flipped on its wrapper, a PNG is not, so
      // swapping one for the other recompiles the draw; none of Babylon's
      // observables announce that, and without it the strict probe is skipped
      // and the visual is not drawn while the new variant compiles.
      if (replaced && replaced !== next.resource && usesDirectUv(replaced) !== usesDirectUv(next.resource)) {
        markSceneReadinessDirty(scene);
      }
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
    applyAlbedoTexture(mesh, mesh.getScene(), binding.guid, assets, { alwaysBlend: binding.alwaysBlend });
    if (binding.preparation && binding.preparation !== before) pending.push(binding.preparation);
  }
  return pending;
}

/**
 * Tilemap atlases keep their exact display colors: the scene's tone mapping and
 * exposure never apply to them. Under a Scene Linear display stage they still
 * decode to linear, like Standard materials on the scene's configuration, so
 * the Display Color stage encodes them once.
 */
class AtlasImageProcessing extends ImageProcessingConfiguration {
  private readonly sceneConfiguration: ImageProcessingConfiguration;
  constructor(sceneConfiguration: ImageProcessingConfiguration) {
    super();
    this.sceneConfiguration = sceneConfiguration;
    this.isEnabled = false;
    sceneConfiguration.onUpdateParameters.add(() => this._updateParameters());
  }
  override prepareDefines(defines: IImageProcessingConfigurationDefines, forPostProcess = false): void {
    super.prepareDefines(defines, forPostProcess);
    defines.IMAGEPROCESSINGPOSTPROCESS = !forPostProcess && this.sceneConfiguration.applyByPostProcess;
  }
}
const atlasImageProcessing = new WeakMap<Scene, AtlasImageProcessing>();

/** Bind each tilemap chunk child to the atlas stored on `metadata.tilemapTextureGuid`. */
export function applyTilemapAlbedoTextures(
  mesh: Mesh,
  scene: Scene,
  assets?: MeshAssetContext,
): void {
  let imageProcessing = atlasImageProcessing.get(scene);
  if (!imageProcessing) {
    imageProcessing = new AtlasImageProcessing(scene.imageProcessingConfiguration);
    atlasImageProcessing.set(scene, imageProcessing);
  }
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
