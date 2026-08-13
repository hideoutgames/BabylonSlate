import {
  Matrix,
  Mesh,
  Quaternion,
  Scene,
  Vector3,
} from "@babylonjs/core";
import type { ActorSlot, CommandMessage } from "@babylonslate/bridge";
import type { SampledSnapshot } from "./snapshot-sync";
import { createPrimitiveMesh } from "./scene-loader";

/** Scratch math objects — never allocate per actor per frame. */
const scratchPos = new Vector3();
const scratchScale = new Vector3();
const scratchQuat = new Quaternion();
const scratchMatrix = Matrix.Identity();

export interface SnapshotSceneBinding {
  meshes: Map<number, Mesh>;
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
  existing.dispose();
  binding.meshes.set(
    command.slotId,
    createPlayMesh(scene, command.slotId, meshKind),
  );
}

function createPlayMesh(
  scene: Scene,
  slotId: number,
  meshKind: string | null | undefined,
): Mesh {
  return createPrimitiveMesh(scene, `actor-${slotId}`, meshKind);
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
        );
        binding.meshes.set(actor.slotId, mesh);
      }
      writeActorTransform(mesh, actor);
      mesh.isVisible = (actor.flags & 1) === 1;
    }
    for (const [slotId, mesh] of binding.meshes) {
      if (!live.has(slotId)) {
        mesh.dispose();
        binding.meshes.delete(slotId);
        binding.meshKinds.delete(slotId);
        binding.meshAssetGuids.delete(slotId);
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
  binding.meshes.clear();
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
