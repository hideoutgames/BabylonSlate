import {
  DirectionalLight,
  Mesh,
  PointLight,
  Quaternion,
  Scene,
  SpotLight,
  UniversalCamera,
  Vector3,
  type AbstractMesh,
  type Camera,
  type Light,
  type Material,
  type ShadowGenerator,
} from "@babylonjs/core";
import type { ActorSlot, CommandMessage } from "@babylonslate/bridge";
import { emptySkyboxFaces, type SkyboxFaces } from "@babylonslate/core";
import type { SampledSnapshot } from "./snapshot-sync";
import { applyAlbedoTexture, applyTilemapAlbedoTextures, type MeshAssetContext } from "./mesh-assets";
import { createMeshFromModelBytes } from "./model-mesh";
import { beginSlotModelAnimLoad, invalidateSlotAnimLoad } from "./glb-anim";
import { applySerializedTransform, createPrimitiveMesh } from "./scene-loader";
import {
  AUTHORED_CAMERA_PREFIX,
  AUTHORED_LIGHT_PREFIX,
  applyAuthoredCameraProperties,
  applyAuthoredLightProperties,
  attachSingleShadowGenerator,
  shadowMapSizeFromQuality,
  syncDefaultFillLight,
  updateAuthoredCameraTransform,
  updateAuthoredLightTransform,
  type AuthoredCameraProperties,
  type AuthoredLightProperties,
} from "./scene-illumination";
import { createSpriteQuad } from "./sprite-quad";
import {
  applyTilemapParallaxToMesh,
  createTilemapMeshes,
  worldTileSize,
} from "./tilemap-mesh";
import { snapToPixelGrid } from "./pixel-perfect";
import { createSkyboxMesh, resolveSkyboxCubeTexture } from "./skybox";

/** Scratch math objects — never allocate per actor per frame. */
const scratchPos = new Vector3();
const scratchScale = new Vector3();
const scratchQuat = new Quaternion();
const scratchLocalPos = new Vector3();
const scratchPartQuat = new Quaternion();

export type AssignMeshCommand = Extract<CommandMessage, { type: "assignMesh" }>;
export type AssignMeshPart = NonNullable<AssignMeshCommand["parts"]>[number];

export interface SnapshotSceneBinding extends MeshAssetContext {
  meshes: Map<number, Mesh>;
  lights: Map<number, Light>;
  cameras: Map<number, Camera>;
  lightProps: Map<number, AuthoredLightProperties>;
  cameraProps: Map<number, AuthoredCameraProperties>;
  skyboxProps: Map<number, { size: number; faces: SkyboxFaces }>;
  /** Snap the Play camera to the pixel grid (project `twoD.pixelPerfect`). */
  pixelPerfect?: boolean;
  /** Reused each apply — no per-frame Set allocation. */
  liveSlots: Set<number>;
  /** meshKind from assignMesh, keyed by slotId. */
  meshKinds: Map<number, string | null>;
  /** Sprite / mesh asset guid from assignMesh, keyed by slotId. */
  meshAssetGuids: Map<number, string | null>;
  /** Extra component parts from assignMesh, keyed by slotId. */
  meshParts: Map<number, NonNullable<AssignMeshCommand["parts"]>>;
  /** Second sprite mesh used for two-layer clip crossfades. */
  spriteOverlays?: Map<number, Mesh>;
  /** Per-slot AnimationGroups keyed after model load (not the global scene list). */
  slotAnimationGroups?: Map<
    number,
    Array<{
      name: string;
      from: number;
      to: number;
      clipAssetGuid?: string;
      pause(): void;
      goToFrame(frame: number): void;
      setWeightForAllAnimatables?(weight: number): void;
      dispose?(): void;
    }>
  >;
  /** Last animState per slot, replayed when groups become available. */
  pendingAnimState?: Map<number, Extract<CommandMessage, { type: "animState" }>>;
  /** In-flight GLB AnimationGroup loads, keyed by slotId. */
  slotAnimLoads?: Map<number, Promise<void>>;
  /** Cancels in-flight loads when incremented. */
  slotAnimEpoch?: Map<number, number>;
  /** Called after a slot's AnimationGroups are registered (replay pending seek). */
  slotAnimReady?: (slotId: number) => void;
  defaultCameraSlotId: number | null;
  possessedCameraSlotId: number | null;
  shadow: ShadowGenerator | null;
  shadowOwnerSlot: number | null;
  shadowQuality: string;
  /** Material asset guid per slot (whole actor), keyed by slotId. */
  materialAssetGuids: Map<number, string | null>;
  /** Material asset guid per component, keyed by `slotId|componentId`. */
  componentMaterialGuids: Map<string, string | null>;
  /** Resolves an assigned Material guid to a scene-local compiled material. */
  resolveMaterial?: (assetGuid: string) => Material | null;
}

export function createSnapshotSceneBinding(): SnapshotSceneBinding {
  return {
    meshes: new Map(),
    lights: new Map(),
    cameras: new Map(),
    lightProps: new Map(),
    cameraProps: new Map(),
    skyboxProps: new Map(),
    liveSlots: new Set(),
    meshKinds: new Map(),
    meshAssetGuids: new Map(),
    meshParts: new Map(),
    spriteOverlays: new Map(),
    slotAnimationGroups: new Map(),
    pendingAnimState: new Map(),
    slotAnimLoads: new Map(),
    slotAnimEpoch: new Map(),
    defaultCameraSlotId: null,
    possessedCameraSlotId: null,
    shadow: null,
    shadowOwnerSlot: null,
    shadowQuality: "1024",
    materialAssetGuids: new Map(),
    componentMaterialGuids: new Map(),
  };
}

/**
 * Apply an assigned Material to a spawned actor.
 *
 * Multipart actors keep one mesh per visual component, so a whole-actor
 * assignment walks the descendants while a component assignment targets the
 * one named mesh.
 */
export function applyAssignMaterial(
  scene: Scene,
  binding: SnapshotSceneBinding,
  command: Extract<CommandMessage, { type: "assignMaterial" }>,
): void {
  void scene;
  const componentId = command.componentId ?? null;
  if (componentId) {
    binding.componentMaterialGuids.set(
      `${command.slotId}|${componentId}`,
      command.materialAssetGuid,
    );
  } else {
    binding.materialAssetGuids.set(command.slotId, command.materialAssetGuid);
  }
  const root = binding.meshes.get(command.slotId);
  if (!root) return;
  applyMaterialToActorMeshes(binding, command.slotId, root);
}

/** Unique Material guids currently recorded on Play meshes. */
export function assignedMaterialGuids(
  binding: Pick<
    SnapshotSceneBinding,
    "materialAssetGuids" | "componentMaterialGuids"
  >,
): string[] {
  const guids = new Set<string>();
  for (const guid of binding.materialAssetGuids.values()) {
    if (guid) guids.add(guid);
  }
  for (const guid of binding.componentMaterialGuids.values()) {
    if (guid) guids.add(guid);
  }
  return [...guids].sort();
}

/** Re-apply the recorded assignment after a mesh is created or rebuilt. */
export function applyMaterialToActorMeshes(
  binding: SnapshotSceneBinding,
  slotId: number,
  root: Mesh,
): void {
  const actorGuid = binding.materialAssetGuids.get(slotId) ?? null;
  const targets: Mesh[] = [root, ...root.getChildMeshes().filter(isMesh)];
  for (const target of targets) {
    const componentId = componentIdOfPlayMesh(target.name, slotId);
    const componentGuid = componentId
      ? (binding.componentMaterialGuids.get(`${slotId}|${componentId}`) ?? null)
      : null;
    const guid = componentGuid ?? actorGuid;
    if (!guid) continue;
    const material = binding.resolveMaterial?.(guid) ?? null;
    if (material) target.material = material;
  }
}

function isMesh(value: AbstractMesh): value is Mesh {
  return value instanceof Mesh;
}

/** `actor-<slot>|<componentId>` identifies one visual component's mesh. */
function componentIdOfPlayMesh(
  meshName: string,
  slotId: number,
): string | null {
  const prefix = `actor-${slotId}|`;
  if (!meshName.startsWith(prefix)) return null;
  const rest = meshName.slice(prefix.length);
  return rest.includes(":") ? rest.slice(0, rest.indexOf(":")) : rest;
}

export function playComponentMeshName(
  slotId: number,
  componentId: string,
): string {
  return `actor-${slotId}|${componentId}`;
}

function partsNeedOrigin(parts: readonly AssignMeshPart[] | undefined): boolean {
  if (!parts || parts.length === 0) return false;
  if (parts.length > 1) return true;
  const part = parts[0]!;
  return (
    part.position[0] !== 0 ||
    part.position[1] !== 0 ||
    part.position[2] !== 0 ||
    part.rotation[0] !== 0 ||
    part.rotation[1] !== 0 ||
    part.rotation[2] !== 0 ||
    part.rotation[3] !== 1 ||
    part.scale[0] !== 1 ||
    part.scale[1] !== 1 ||
    part.scale[2] !== 1
  );
}

function applyPartTransform(mesh: Mesh, part: AssignMeshPart): void {
  applySerializedTransform(mesh, {
    position: part.position,
    rotation: part.rotation,
    scale: part.scale,
  });
}

function refreshPlayActiveCamera(
  scene: Scene,
  binding: SnapshotSceneBinding,
): void {
  const possessed =
    binding.possessedCameraSlotId !== null
      ? binding.cameras.get(binding.possessedCameraSlotId)
      : undefined;
  if (possessed) {
    scene.activeCamera = possessed;
    return;
  }
  const named =
    binding.defaultCameraSlotId !== null
      ? binding.cameras.get(binding.defaultCameraSlotId)
      : undefined;
  if (named) {
    scene.activeCamera = named;
    return;
  }
  const playDefault = scene.getCameraByName("camera");
  if (playDefault) scene.activeCamera = playDefault;
}

function syncPlayFillLight(scene: Scene, binding: SnapshotSceneBinding): void {
  syncDefaultFillLight(scene, binding.lights.size > 0);
}

function applyPlayShadows(scene: Scene, binding: SnapshotSceneBinding): void {
  const mapSize = shadowMapSizeFromQuality(binding.shadowQuality);
  if (mapSize === null || binding.shadowOwnerSlot === null) {
    binding.shadow?.dispose();
    binding.shadow = null;
    return;
  }
  const light = binding.lights.get(binding.shadowOwnerSlot);
  if (!light) {
    binding.shadow?.dispose();
    binding.shadow = null;
    binding.shadowOwnerSlot = null;
    return;
  }
  if (!binding.shadow) {
    binding.shadow = attachSingleShadowGenerator(scene, light, mapSize, null);
  }
}

/** Remember (and rebuild) the Play mesh for a slot from an assignMesh command. */
export function applyAssignMesh(
  scene: Scene,
  binding: SnapshotSceneBinding,
  command: AssignMeshCommand,
): void {
  const meshKind = command.meshKind ?? null;
  binding.meshKinds.set(command.slotId, meshKind);
  binding.meshAssetGuids.set(command.slotId, command.meshAssetGuid);
  if (command.parts && command.parts.length > 0) {
    binding.meshParts.set(command.slotId, command.parts);
  } else {
    binding.meshParts.delete(command.slotId);
  }
  if (command.light) binding.lightProps.set(command.slotId, command.light);
  if (command.skybox) {
    binding.skyboxProps.set(command.slotId, command.skybox);
  } else if (meshKind === "skybox") {
    binding.skyboxProps.set(command.slotId, {
      size: 1000,
      faces: emptySkyboxFaces(),
    });
  }
  if (command.camera) {
    binding.cameraProps.set(command.slotId, command.camera);
    if (command.camera.isDefault) {
      binding.defaultCameraSlotId = command.slotId;
    } else if (binding.defaultCameraSlotId === command.slotId) {
      binding.defaultCameraSlotId = null;
    }
  }
  const existingLight = binding.lights.get(command.slotId);
  if (existingLight && command.light) {
    applyAuthoredLightProperties(existingLight, command.light);
    if (command.light.castShadows && binding.shadowOwnerSlot === null) {
      binding.shadowOwnerSlot = command.slotId;
    }
    applyPlayShadows(scene, binding);
    refreshPlayActiveCamera(scene, binding);
    syncPlayFillLight(scene, binding);
    return;
  }
  const existingCamera = binding.cameras.get(command.slotId);
  if (existingCamera && command.camera) {
    applyAuthoredCameraProperties(existingCamera, command.camera);
    refreshPlayActiveCamera(scene, binding);
    return;
  }
  const existing = binding.meshes.get(command.slotId);
  if (existing) {
    disposeSlotVisuals(scene, binding, command.slotId);
  }
  const rebuilt = createPlayVisual(scene, command.slotId, binding);
  binding.meshes.set(command.slotId, rebuilt);
  // A rebuilt mesh loses its material, so re-apply the recorded assignment.
  applyMaterialToActorMeshes(binding, command.slotId, rebuilt);
  setPlayVisualVisibility(rebuilt, binding.liveSlots.has(command.slotId));
  refreshPlayActiveCamera(scene, binding);
  syncPlayFillLight(scene, binding);
}

function playMeshMetadata(
  mesh: Mesh,
): { playActorOrigin?: boolean; playHelperVisual?: boolean } | null {
  return (mesh.metadata as {
    playActorOrigin?: boolean;
    playHelperVisual?: boolean;
  } | null);
}

function isPlayActorOrigin(mesh: Mesh): boolean {
  return Boolean(playMeshMetadata(mesh)?.playActorOrigin);
}

function isPlayHelperVisual(mesh: Mesh): boolean {
  const meta = playMeshMetadata(mesh);
  return Boolean(meta?.playHelperVisual || meta?.playActorOrigin);
}

export function isPlayHelperMeshKind(
  meshKind: string | null | undefined,
): boolean {
  if (!meshKind) return true;
  return (
    meshKind === "camera" ||
    meshKind === "audio" ||
    meshKind === "particle" ||
    meshKind.startsWith("light:")
  );
}

function markPlayHelperVisual(mesh: Mesh): void {
  mesh.isVisible = false;
  mesh.isPickable = false;
  mesh.metadata = { ...(mesh.metadata ?? {}), playHelperVisual: true };
}

function setPlayVisualVisibility(mesh: Mesh, visible: boolean): void {
  const origin = isPlayActorOrigin(mesh);
  const helper = isPlayHelperVisual(mesh);
  mesh.isVisible = origin || helper ? false : visible;
  if (!origin) return;
  for (const child of mesh.getChildMeshes()) {
    if (!child.name.includes("|")) continue;
    const afterPipe = child.name.slice(child.name.indexOf("|") + 1);
    if (afterPipe.includes(":")) continue;
    if (isMesh(child) && isPlayHelperVisual(child)) {
      child.isVisible = false;
      continue;
    }
    child.isVisible = visible;
  }
}

export function applyPossessCamera(
  scene: Scene,
  binding: SnapshotSceneBinding,
  slotId: number,
): void {
  binding.possessedCameraSlotId = slotId;
  refreshPlayActiveCamera(scene, binding);
}

export function applyShadowQuality(
  scene: Scene,
  binding: SnapshotSceneBinding,
  level: string,
): void {
  binding.shadowQuality = level;
  binding.shadow?.dispose();
  binding.shadow = null;
  applyPlayShadows(scene, binding);
}

function disposeSlotVisuals(
  scene: Scene,
  binding: SnapshotSceneBinding,
  slotId: number,
): void {
  binding.meshes.get(slotId)?.dispose();
  binding.meshes.delete(slotId);
  binding.spriteOverlays?.get(slotId)?.dispose();
  binding.spriteOverlays?.delete(slotId);
  invalidateSlotAnimLoad(binding, slotId);
  binding.lights.get(slotId)?.dispose();
  binding.lights.delete(slotId);
  binding.cameras.get(slotId)?.dispose();
  binding.cameras.delete(slotId);
  binding.skyboxProps.delete(slotId);
  if (binding.shadowOwnerSlot === slotId) {
    binding.shadow?.dispose();
    binding.shadow = null;
    binding.shadowOwnerSlot = null;
  }
  syncPlayFillLight(scene, binding);
}

function createPlayVisual(
  scene: Scene,
  slotId: number,
  binding: SnapshotSceneBinding,
): Mesh {
  const parts = binding.meshParts.get(slotId);
  const meshKind = binding.meshKinds.get(slotId);
  const assetGuid = binding.meshAssetGuids.get(slotId);
  if (!partsNeedOrigin(parts)) {
    return createPlayMesh(scene, slotId, meshKind, assetGuid, binding);
  }
  const root = createPrimitiveMesh(scene, `actor-${slotId}`, null);
  root.isVisible = false;
  root.metadata = { ...(root.metadata ?? {}), playActorOrigin: true };
  const meshes = new Map<string, Mesh>();
  for (const part of parts ?? []) {
    const child = createPlayMesh(
      scene,
      slotId,
      part.meshKind,
      part.meshAssetGuid,
      binding,
      playComponentMeshName(slotId, part.componentId),
    );
    applyPartTransform(child, part);
    meshes.set(part.componentId, child);
  }
  for (const part of parts ?? []) {
    const child = meshes.get(part.componentId);
    if (!child) continue;
    const parent = part.parentId ? meshes.get(part.parentId) : undefined;
    child.parent = parent ?? root;
  }
  return root;
}

export function createPlayMesh(
  scene: Scene,
  slotId: number,
  meshKind: string | null | undefined,
  assetGuid?: string | null,
  binding?: SnapshotSceneBinding,
  meshName?: string,
): Mesh {
  const name = meshName ?? `actor-${slotId}`;
  if (meshKind === "tilemap" && assetGuid && binding?.tilemaps) {
    const tilemap = binding.tilemaps.get(assetGuid);
    const tilesets = binding.tilesets ?? new Map();
    if (tilemap && tilesets.size > 0) {
      const size = worldTileSize(tilemap, binding.pixelsPerUnit ?? 100);
      const mesh = createTilemapMeshes(
        scene,
        name,
        tilemap,
        tilesets,
        size.width,
        size.height,
      );
      applyTilemapAlbedoTextures(mesh, scene, binding);
      return mesh;
    }
  }
  if (meshKind === "sprite") {
    const payload = assetGuid ? binding?.spritePayloads?.get(assetGuid) : undefined;
    const frame = payload?.frames[0];
    const mesh = frame
      ? createSpriteQuad(scene, name, frame, payload?.pixelsPerUnit ?? binding?.pixelsPerUnit)
      : createPrimitiveMesh(scene, name, "sprite");
    applyAlbedoTexture(mesh, scene, payload?.textureGuid, binding);
    if (frame && binding) {
      if (!binding.spriteOverlays) binding.spriteOverlays = new Map();
      const overlay = createSpriteQuad(
        scene,
        `${name}-blend`,
        frame,
        payload?.pixelsPerUnit ?? binding.pixelsPerUnit,
      );
      overlay.parent = mesh;
      overlay.visibility = 0;
      applyAlbedoTexture(overlay, scene, payload?.textureGuid, binding);
      binding.spriteOverlays.set(slotId, overlay);
    }
    return mesh;
  }
  if (assetGuid && binding?.modelBytes?.has(assetGuid)) {
    const loaded = createMeshFromModelBytes(
      scene,
      name,
      binding.modelBytes.get(assetGuid)!,
    );
    if (loaded) {
      void beginSlotModelAnimLoad(
        scene,
        binding,
        slotId,
        assetGuid,
        binding.modelBytes.get(assetGuid)!,
        loaded,
      );
      return loaded;
    }
  }
  if (meshKind === "skybox") {
    const props = binding?.skyboxProps.get(slotId);
    const texture = resolveSkyboxCubeTexture(
      scene,
      props?.faces ?? emptySkyboxFaces(),
      binding,
    );
    return createSkyboxMesh(scene, name, texture, props?.size ?? 1000);
  }
  if (isPlayHelperMeshKind(meshKind)) {
    const mesh = createPrimitiveMesh(scene, name, null);
    markPlayHelperVisual(mesh);
    if (meshKind?.startsWith("light:") && binding) {
      const kind = meshKind.slice("light:".length);
      const lightName = `${AUTHORED_LIGHT_PREFIX}${slotId}`;
      const light =
        kind === "directional"
          ? new DirectionalLight(lightName, new Vector3(0, 0, 1), scene)
          : kind === "spot"
            ? new SpotLight(
                lightName,
                Vector3.Zero(),
                new Vector3(0, 0, 1),
                Math.PI / 3,
                2,
                scene,
              )
            : new PointLight(lightName, Vector3.Zero(), scene);
      const props = binding.lightProps.get(slotId);
      if (props) applyAuthoredLightProperties(light, props);
      binding.lights.set(slotId, light);
      if (props?.castShadows && binding.shadowOwnerSlot === null) {
        binding.shadowOwnerSlot = slotId;
      }
      applyPlayShadows(scene, binding);
    }
    if (meshKind === "camera" && binding) {
      const camera = new UniversalCamera(
        `${AUTHORED_CAMERA_PREFIX}${slotId}`,
        Vector3.Zero(),
        scene,
      );
      camera.minZ = 0.1;
      camera.maxZ = 1000;
      camera.rotationQuaternion = Quaternion.Identity();
      camera.rotation.set(0, 0, 0);
      camera.detachControl();
      camera.inputs.clear();
      const props = binding.cameraProps.get(slotId);
      if (props) applyAuthoredCameraProperties(camera, props);
      binding.cameras.set(slotId, camera);
      refreshPlayActiveCamera(scene, binding);
    }
    return mesh;
  }
  return createPrimitiveMesh(scene, name, meshKind);
}

/**
 * Apply an interpolated snapshot to the scene. Bulk path wraps Babylon block
 * helpers to avoid per-mesh dirty storms.
 */
export function applySnapshotToScene(
  scene: Scene,
  binding: SnapshotSceneBinding,
  snapshot: SampledSnapshot,
): void {
  scene.blockMaterialDirtyMechanism = true;
  const prevBlock = scene.blockfreeActiveMeshesAndRenderingGroups;
  scene.blockfreeActiveMeshesAndRenderingGroups = true;
  try {
    const live = binding.liveSlots;
    live.clear();
    const count = snapshot.actorCount ?? snapshot.actors.length;
    for (let i = 0; i < count; i++) {
      const actor = snapshot.actors[i]!;
      live.add(actor.slotId);
      let mesh = binding.meshes.get(actor.slotId);
      if (!mesh) {
        mesh = createPlayVisual(scene, actor.slotId, binding);
        binding.meshes.set(actor.slotId, mesh);
        applyMaterialToActorMeshes(binding, actor.slotId, mesh);
      }
      writeActorTransform(mesh, actor);
      setPlayVisualVisibility(mesh, (actor.flags & 1) === 1);
      const light = binding.lights.get(actor.slotId);
      if (light) {
        const composed = composeSlotPartTransform(actor, binding, actor.slotId);
        updateAuthoredLightTransform(light, composed.position, composed.rotation);
      }
      const camera = binding.cameras.get(actor.slotId);
      if (camera) {
        const composed = composeSlotPartTransform(actor, binding, actor.slotId);
        updateAuthoredCameraTransform(camera, composed.position, composed.rotation);
      }
      applyTilemapParallaxToMesh(
        mesh,
        scene.activeCamera ?? { position: actor.position },
      );
    }
    snapPlayCameraToPixelGrid(scene, binding);
    for (const [slotId, mesh] of binding.meshes) {
      if (!live.has(slotId)) {
        mesh.dispose();
        binding.meshes.delete(slotId);
        binding.meshKinds.delete(slotId);
        binding.meshAssetGuids.delete(slotId);
        binding.meshParts.delete(slotId);
        binding.materialAssetGuids.delete(slotId);
        binding.spriteOverlays?.get(slotId)?.dispose();
        binding.spriteOverlays?.delete(slotId);
        invalidateSlotAnimLoad(binding, slotId);
        binding.pendingAnimState?.delete(slotId);
        for (const key of [...binding.componentMaterialGuids.keys()]) {
          if (key.startsWith(`${slotId}|`)) {
            binding.componentMaterialGuids.delete(key);
          }
        }
        binding.lightProps.delete(slotId);
        binding.cameraProps.delete(slotId);
        binding.skyboxProps.delete(slotId);
        binding.lights.get(slotId)?.dispose();
        binding.lights.delete(slotId);
        binding.cameras.get(slotId)?.dispose();
        binding.cameras.delete(slotId);
        if (binding.defaultCameraSlotId === slotId) {
          binding.defaultCameraSlotId = null;
        }
        if (binding.possessedCameraSlotId === slotId) {
          binding.possessedCameraSlotId = null;
        }
        if (binding.shadowOwnerSlot === slotId) {
          binding.shadow?.dispose();
          binding.shadow = null;
          binding.shadowOwnerSlot = null;
        }
      }
    }
    refreshPlayActiveCamera(scene, binding);
    syncPlayFillLight(scene, binding);
  } finally {
    scene.blockMaterialDirtyMechanism = false;
    scene.blockfreeActiveMeshesAndRenderingGroups = prevBlock;
  }
}

function snapPlayCameraToPixelGrid(
  scene: Scene,
  binding: SnapshotSceneBinding,
): void {
  if (!binding.pixelPerfect) return;
  const camera = scene.activeCamera;
  if (!camera) return;
  const ppu = binding.pixelsPerUnit && binding.pixelsPerUnit > 0
    ? binding.pixelsPerUnit
    : 100;
  camera.position.x = snapToPixelGrid(camera.position.x, ppu);
  camera.position.y = snapToPixelGrid(camera.position.y, ppu);
}

export function disposeSnapshotBinding(binding: SnapshotSceneBinding): void {
  for (const mesh of binding.meshes.values()) {
    mesh.dispose();
  }
  for (const overlay of binding.spriteOverlays?.values() ?? []) {
    overlay.dispose();
  }
  for (const slotId of [...(binding.slotAnimationGroups?.keys() ?? [])]) {
    invalidateSlotAnimLoad(binding, slotId);
  }
  for (const light of binding.lights.values()) light.dispose();
  for (const camera of binding.cameras.values()) camera.dispose();
  binding.shadow?.dispose();
  binding.meshes.clear();
  binding.spriteOverlays?.clear();
  binding.slotAnimationGroups?.clear();
  binding.pendingAnimState?.clear();
  binding.slotAnimLoads?.clear();
  binding.slotAnimEpoch?.clear();
  binding.lights.clear();
  binding.cameras.clear();
  binding.lightProps.clear();
  binding.cameraProps.clear();
  binding.meshKinds.clear();
  binding.meshAssetGuids.clear();
  binding.meshParts.clear();
  binding.shadow = null;
  binding.shadowOwnerSlot = null;
  binding.defaultCameraSlotId = null;
  binding.possessedCameraSlotId = null;
}

function composeSlotPartTransform(
  actor: ActorSlot,
  binding: SnapshotSceneBinding,
  slotId: number,
): {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
} {
  const part = binding.meshParts.get(slotId)?.[0];
  if (!part) {
    return { position: actor.position, rotation: actor.rotation };
  }
  scratchQuat.set(
    actor.rotation.x,
    actor.rotation.y,
    actor.rotation.z,
    actor.rotation.w,
  );
  scratchLocalPos.set(
    part.position[0] * actor.scale.x,
    part.position[1] * actor.scale.y,
    part.position[2] * actor.scale.z,
  );
  scratchLocalPos.applyRotationQuaternionInPlace(scratchQuat);
  scratchPartQuat.set(
    part.rotation[0],
    part.rotation[1],
    part.rotation[2],
    part.rotation[3],
  );
  const rotation = scratchQuat.multiply(scratchPartQuat);
  return {
    position: {
      x: actor.position.x + scratchLocalPos.x,
      y: actor.position.y + scratchLocalPos.y,
      z: actor.position.z + scratchLocalPos.z,
    },
    rotation: {
      x: rotation.x,
      y: rotation.y,
      z: rotation.z,
      w: rotation.w,
    },
  };
}

function writeActorTransform(mesh: Mesh, actor: ActorSlot): void {
  scratchPos.set(actor.position.x, actor.position.y, actor.position.z);
  scratchScale.set(actor.scale.x, actor.scale.y, actor.scale.z);
  scratchQuat.set(
    actor.rotation.x,
    actor.rotation.y,
    actor.rotation.z,
    actor.rotation.w,
  );
  // Keep local TRS in sync for gizmos / picking later.
  mesh.position.copyFrom(scratchPos);
  mesh.rotationQuaternion = mesh.rotationQuaternion ?? new Quaternion();
  mesh.rotationQuaternion.copyFrom(scratchQuat);
  mesh.scaling.copyFrom(scratchScale);
  // No shared Matrix argument: Babylon caches an independent world matrix for
  // every actor slot. Sharing the scratch matrix collapses all rendered meshes.
  mesh.freezeWorldMatrix();
}
