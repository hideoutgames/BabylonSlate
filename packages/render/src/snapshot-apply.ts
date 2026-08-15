import {
  DirectionalLight,
  Matrix,
  Mesh,
  PointLight,
  Quaternion,
  Scene,
  SpotLight,
  UniversalCamera,
  Vector3,
  type Camera,
  type Light,
  type ShadowGenerator,
} from "@babylonjs/core";
import type { ActorSlot, CommandMessage } from "@babylonslate/bridge";
import type { SampledSnapshot } from "./snapshot-sync";
import { applyAlbedoTexture, type MeshAssetContext } from "./mesh-assets";
import { createMeshFromModelBytes } from "./model-mesh";
import { createPrimitiveMesh } from "./scene-loader";
import {
  AUTHORED_CAMERA_PREFIX,
  AUTHORED_LIGHT_PREFIX,
  applyAuthoredCameraProperties,
  applyAuthoredLightProperties,
  attachSingleShadowGenerator,
  shadowMapSizeFromQuality,
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

/** Scratch math objects — never allocate per actor per frame. */
const scratchPos = new Vector3();
const scratchScale = new Vector3();
const scratchQuat = new Quaternion();
const scratchMatrix = Matrix.Identity();

export interface SnapshotSceneBinding extends MeshAssetContext {
  meshes: Map<number, Mesh>;
  lights: Map<number, Light>;
  cameras: Map<number, Camera>;
  lightProps: Map<number, AuthoredLightProperties>;
  cameraProps: Map<number, AuthoredCameraProperties>;
  /** Snap the Play camera to the pixel grid (project `twoD.pixelPerfect`). */
  pixelPerfect?: boolean;
  /** Reused each apply — no per-frame Set allocation. */
  liveSlots: Set<number>;
  /** meshKind from assignMesh, keyed by slotId. */
  meshKinds: Map<number, string | null>;
  /** Sprite / mesh asset guid from assignMesh, keyed by slotId. */
  meshAssetGuids: Map<number, string | null>;
  defaultCameraSlotId: number | null;
  possessedCameraSlotId: number | null;
  shadow: ShadowGenerator | null;
  shadowOwnerSlot: number | null;
  shadowQuality: string;
}

export function createSnapshotSceneBinding(): SnapshotSceneBinding {
  return {
    meshes: new Map(),
    lights: new Map(),
    cameras: new Map(),
    lightProps: new Map(),
    cameraProps: new Map(),
    liveSlots: new Set(),
    meshKinds: new Map(),
    meshAssetGuids: new Map(),
    defaultCameraSlotId: null,
    possessedCameraSlotId: null,
    shadow: null,
    shadowOwnerSlot: null,
    shadowQuality: "1024",
  };
}

export type AssignMeshCommand = Extract<CommandMessage, { type: "assignMesh" }>;

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
  if (command.light) binding.lightProps.set(command.slotId, command.light);
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
    return;
  }
  const existingCamera = binding.cameras.get(command.slotId);
  if (existingCamera && command.camera) {
    applyAuthoredCameraProperties(existingCamera, command.camera);
    refreshPlayActiveCamera(scene, binding);
    return;
  }
  const existing = binding.meshes.get(command.slotId);
  if (!existing) return;
  disposeSlotVisuals(scene, binding, command.slotId);
  binding.meshes.set(
    command.slotId,
    createPlayMesh(
      scene,
      command.slotId,
      meshKind,
      command.meshAssetGuid,
      binding,
    ),
  );
  refreshPlayActiveCamera(scene, binding);
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
  binding.lights.get(slotId)?.dispose();
  binding.lights.delete(slotId);
  binding.cameras.get(slotId)?.dispose();
  binding.cameras.delete(slotId);
  if (binding.shadowOwnerSlot === slotId) {
    binding.shadow?.dispose();
    binding.shadow = null;
    binding.shadowOwnerSlot = null;
  }
  void scene;
}

export function createPlayMesh(
  scene: Scene,
  slotId: number,
  meshKind: string | null | undefined,
  assetGuid?: string | null,
  binding?: SnapshotSceneBinding,
): Mesh {
  const name = `actor-${slotId}`;
  if (meshKind === "tilemap" && assetGuid && binding?.tilemaps) {
    const tilemap = binding.tilemaps.get(assetGuid);
    const tileset = tilemap?.tilesetGuid
      ? binding.tilesets?.get(tilemap.tilesetGuid)
      : undefined;
    if (tilemap && tileset) {
      const size = worldTileSize(tilemap, binding.pixelsPerUnit ?? 100);
      const mesh = createTilemapMeshes(
        scene,
        name,
        tilemap,
        tileset,
        size.width,
        size.height,
      );
      applyAlbedoTexture(mesh, scene, tileset.textureGuid, binding);
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
    return mesh;
  }
  if (assetGuid && binding?.modelBytes?.has(assetGuid)) {
    const loaded = createMeshFromModelBytes(
      scene,
      name,
      binding.modelBytes.get(assetGuid)!,
    );
    if (loaded) return loaded;
  }
  if (meshKind?.startsWith("light:") && binding) {
    const mesh = createPrimitiveMesh(scene, name, null);
    mesh.isVisible = false;
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
    return mesh;
  }
  if (meshKind === "camera" && binding) {
    const mesh = createPrimitiveMesh(scene, name, null);
    mesh.isVisible = false;
    const camera = new UniversalCamera(
      `${AUTHORED_CAMERA_PREFIX}${slotId}`,
      Vector3.Zero(),
      scene,
    );
    camera.minZ = 0.1;
    camera.maxZ = 1000;
    camera.rotationQuaternion = Quaternion.Identity();
    camera.detachControl();
    camera.inputs.clear();
    const props = binding.cameraProps.get(slotId);
    if (props) applyAuthoredCameraProperties(camera, props);
    binding.cameras.set(slotId, camera);
    refreshPlayActiveCamera(scene, binding);
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
        mesh = createPlayMesh(
          scene,
          actor.slotId,
          binding.meshKinds.get(actor.slotId),
          binding.meshAssetGuids.get(actor.slotId),
          binding,
        );
        binding.meshes.set(actor.slotId, mesh);
      }
      writeActorTransform(mesh, actor);
      mesh.isVisible = (actor.flags & 1) === 1;
      const light = binding.lights.get(actor.slotId);
      if (light) {
        updateAuthoredLightTransform(light, actor.position, actor.rotation);
      }
      const camera = binding.cameras.get(actor.slotId);
      if (camera) {
        updateAuthoredCameraTransform(camera, actor.position, actor.rotation);
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
        binding.lightProps.delete(slotId);
        binding.cameraProps.delete(slotId);
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
  for (const light of binding.lights.values()) light.dispose();
  for (const camera of binding.cameras.values()) camera.dispose();
  binding.shadow?.dispose();
  binding.meshes.clear();
  binding.lights.clear();
  binding.cameras.clear();
  binding.lightProps.clear();
  binding.cameraProps.clear();
  binding.meshKinds.clear();
  binding.meshAssetGuids.clear();
  binding.shadow = null;
  binding.shadowOwnerSlot = null;
  binding.defaultCameraSlotId = null;
  binding.possessedCameraSlotId = null;
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
  Matrix.ComposeToRef(scratchScale, scratchQuat, scratchPos, scratchMatrix);
  mesh.freezeWorldMatrix(scratchMatrix);
  // Keep local TRS in sync for gizmos / picking later.
  mesh.position.copyFrom(scratchPos);
  mesh.rotationQuaternion = mesh.rotationQuaternion ?? new Quaternion();
  mesh.rotationQuaternion.copyFrom(scratchQuat);
  mesh.scaling.copyFrom(scratchScale);
}
