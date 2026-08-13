import {
  ArcRotateCamera,
  Color3,
  DirectionalLight,
  Matrix,
  Mesh,
  PointLight,
  Quaternion,
  Scene,
  SpotLight,
  Vector3,
  type Camera,
  type Light,
} from "@babylonjs/core";
import type { ActorSlot, CommandMessage } from "@babylonslate/bridge";
import type { SampledSnapshot } from "./snapshot-sync";
import { applyAlbedoTexture, type MeshAssetContext } from "./mesh-assets";
import { createMeshFromModelBytes } from "./model-mesh";
import { createPrimitiveMesh } from "./scene-loader";
import {
  AUTHORED_CAMERA_PREFIX,
  AUTHORED_LIGHT_PREFIX,
  updateAuthoredLightTransform,
} from "./scene-illumination";
import { createSpriteQuad } from "./sprite-quad";
import { createTilemapMeshes, worldTileSize } from "./tilemap-mesh";

/** Scratch math objects — never allocate per actor per frame. */
const scratchPos = new Vector3();
const scratchScale = new Vector3();
const scratchQuat = new Quaternion();
const scratchMatrix = Matrix.Identity();

export interface SnapshotSceneBinding extends MeshAssetContext {
  meshes: Map<number, Mesh>;
  lights: Map<number, Light>;
  cameras: Map<number, Camera>;
  /** Reused each apply — no per-frame Set allocation. */
  liveSlots: Set<number>;
  /** meshKind from assignMesh, keyed by slotId. */
  meshKinds: Map<number, string | null>;
  /** Sprite / mesh asset guid from assignMesh, keyed by slotId. */
  meshAssetGuids: Map<number, string | null>;
}

export function createSnapshotSceneBinding(): SnapshotSceneBinding {
  return {
    meshes: new Map(),
    lights: new Map(),
    cameras: new Map(),
    liveSlots: new Set(),
    meshKinds: new Map(),
    meshAssetGuids: new Map(),
  };
}

export type AssignMeshCommand = Extract<CommandMessage, { type: "assignMesh" }>;

/** Remember (and rebuild) the Play mesh for a slot from an assignMesh command. */
export function applyAssignMesh(
  scene: Scene,
  binding: SnapshotSceneBinding,
  command: AssignMeshCommand,
): void {
  const meshKind = command.meshKind ?? null;
  binding.meshKinds.set(command.slotId, meshKind);
  binding.meshAssetGuids.set(command.slotId, command.meshAssetGuid);
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
        ? new DirectionalLight(lightName, new Vector3(0, -1, 0), scene)
        : kind === "spot"
          ? new SpotLight(
              lightName,
              Vector3.Zero(),
              new Vector3(0, -1, 0),
              Math.PI / 3,
              2,
              scene,
            )
          : new PointLight(lightName, Vector3.Zero(), scene);
    light.diffuse = Color3.White();
    binding.lights.set(slotId, light);
    return mesh;
  }
  if (meshKind === "camera" && binding) {
    const mesh = createPrimitiveMesh(scene, name, null);
    mesh.isVisible = false;
    const camera = new ArcRotateCamera(
      `${AUTHORED_CAMERA_PREFIX}${slotId}`,
      -Math.PI / 2,
      Math.PI / 2.5,
      8,
      Vector3.Zero(),
      scene,
    );
    binding.cameras.set(slotId, camera);
    scene.activeCamera = camera;
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
      if (light) updateAuthoredLightTransform(light, actor.position);
      const camera = binding.cameras.get(actor.slotId);
      if (camera && "setPosition" in camera) {
        (camera as ArcRotateCamera).setPosition(scratchPos);
      }
    }
    for (const [slotId, mesh] of binding.meshes) {
      if (!live.has(slotId)) {
        mesh.dispose();
        binding.meshes.delete(slotId);
        binding.meshKinds.delete(slotId);
        binding.meshAssetGuids.delete(slotId);
        binding.lights.get(slotId)?.dispose();
        binding.lights.delete(slotId);
        binding.cameras.get(slotId)?.dispose();
        binding.cameras.delete(slotId);
      }
    }
  } finally {
    scene.blockMaterialDirtyMechanism = false;
    scene.blockfreeActiveMeshesAndRenderingGroups = prevBlock;
  }
}

export function disposeSnapshotBinding(binding: SnapshotSceneBinding): void {
  for (const mesh of binding.meshes.values()) {
    mesh.dispose();
  }
  for (const light of binding.lights.values()) light.dispose();
  for (const camera of binding.cameras.values()) camera.dispose();
  binding.meshes.clear();
  binding.lights.clear();
  binding.cameras.clear();
  binding.meshKinds.clear();
  binding.meshAssetGuids.clear();
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
