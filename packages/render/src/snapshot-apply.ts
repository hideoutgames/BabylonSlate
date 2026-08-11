import {
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  Vector3,
} from "@babylonjs/core";
import type { ActorSlot } from "@babylonslate/bridge";
import type { SampledSnapshot } from "./snapshot-sync";

/** Scratch math objects — never allocate per actor per frame. */
const scratchPos = new Vector3();
const scratchScale = new Vector3();
const scratchQuat = new Quaternion();
const scratchMatrix = Matrix.Identity();

export interface SnapshotSceneBinding {
  meshes: Map<number, Mesh>;
  /** Reused each apply — no per-frame Set allocation. */
  liveSlots: Set<number>;
}

export function createSnapshotSceneBinding(): SnapshotSceneBinding {
  return { meshes: new Map(), liveSlots: new Set() };
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
        mesh = MeshBuilder.CreateBox(`actor-${actor.slotId}`, { size: 1 }, scene);
        binding.meshes.set(actor.slotId, mesh);
      }
      writeActorTransform(mesh, actor);
      mesh.isVisible = (actor.flags & 1) === 1;
    }
    for (const [slotId, mesh] of binding.meshes) {
      if (!live.has(slotId)) {
        mesh.dispose();
        binding.meshes.delete(slotId);
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
