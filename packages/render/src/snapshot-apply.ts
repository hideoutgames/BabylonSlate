import { setFogVolumesVisible } from "./fog-volumes";
import { sampleSceneWaterFrame } from "./water-mesh";
import { sampleCableFrame } from "./cable-mesh";
import {
  Quaternion,
  Vector3,
  type Mesh,
  type Scene,
} from "@babylonjs/core";
import {
  SNAPSHOT_FLAG_OVERLAY,
  SNAPSHOT_FLAG_VISIBLE,
  type ActorSlot,
} from "@haptic/bridge";
import type { SampledSnapshot } from "./snapshot-sync";
import { invalidateSlotAnimLoad } from "./glb-anim";
import {
  shouldFreezeStaticWorldMatrix,
  unfreezeActorWorldMatrix,
} from "./scene-loader";
import {
  composeActorComponentTransformToRef,
  updateAuthoredCameraTransform,
  updateAuthoredLightTransform,
} from "./scene-illumination";
import {
  updateSceneTilemapAnimations,
  updateSceneTilemapParallax,
} from "./tilemap-mesh";
import { retireBoneAttachments, updateBoneAttachments } from "./bone-attachment";
export { applyAttachToBone } from "./bone-attachment";
import { slotKeysOf, type SnapshotSceneBinding } from "./snapshot-binding";
import {
  appliedPlayVisibilityOf,
  disposeWorldOverlayLeftoverSlots,
  setPlayVisualVisibility,
} from "./snapshot-visibility";
import {
  applyMaterialToActorMeshes,
  disposeMaterialPreparations,
  releaseAllRetainedMaterialOwners,
  releaseRetainedMaterialOwners,
} from "./snapshot-materials";
import {
  hasActorIllumination,
  refreshPlayActiveCamera,
  snapPlayCameraToPixelGrid,
  updateComponentIllumination,
} from "./snapshot-illumination";
import {
  disposeSpringArmState,
  retireSpringArmLag,
  updatePlaySpringArms,
} from "./snapshot-spring-arms";
import {
  cancelPendingVisualReplacement,
  disposePendingVisualReplacements,
  forgetVisualAssignment,
  forgetVisualAssignments,
} from "./snapshot-component-commands";
import { createPlayVisual } from "./snapshot-visual-factory";
import {
  disposeRejectedAssignments,
  forgetRejectedAssignments,
} from "./snapshot-assign-mesh";

// The Play applier is split by concern; this module keeps the per-frame apply
// and slot lifecycle and re-exports the public names of the others.
export type {
  AssignMeshCommand,
  AssignMeshPart,
  SnapshotSceneBinding,
} from "./snapshot-binding";
export {
  createSnapshotSceneBinding,
  componentIdForPlayMesh,
  playComponentMeshName,
  meshForPlayComponent,
} from "./snapshot-binding";
export {
  applyAssignMaterial,
  applySetMaterialParameter,
  assignedMaterialGuids,
  wantsOverlayUnlitMaterial,
  applyMaterialToActorMeshes,
} from "./snapshot-materials";
export {
  PLAY_FREE_CAM_NAME,
  resolvePlayGameCamera,
  refreshPlayActiveCamera,
  applyPossessCamera,
} from "./snapshot-illumination";
export {
  isPlayConsoleVizSkipMesh,
  disposeWorldOverlayLeftovers,
} from "./snapshot-visibility";
export {
  retainAssignMeshComponentTransforms,
  applyComponentTransformsCommand,
  applyOverlayVisualStyleCommand,
  applyText2DAppearCommand,
  applyUIControl2DCommand,
  applyPainter2DCommand,
} from "./snapshot-component-commands";
export { createPlayMesh, isPlayHelperMeshKind } from "./snapshot-visual-factory";
export { applyAssignMesh } from "./snapshot-assign-mesh";

/** Scratch math objects — never allocate per actor per frame. */
const scratchPos = new Vector3();
const scratchScale = new Vector3();
const scratchQuat = new Quaternion();
const scratchComposedPart = { position: new Vector3(), rotation: new Quaternion() };
const scratchBoneSlot: ActorSlot = {
  slotId: 0, flags: 0, position: new Vector3(), rotation: new Quaternion(), scale: new Vector3(),
};

/** Rebuild a Play mesh in `scene` when it was created on the wrong host Scene. */
export function migratePlaySlotVisual(
  scene: Scene,
  binding: SnapshotSceneBinding,
  slotId: number,
): Mesh | null {
  const existing = binding.meshes.get(slotId);
  if (!existing) return null;
  if (existing.getScene() === scene) return existing;
  cancelPendingVisualReplacement(binding, slotId);
  const position = existing.position.clone();
  const rotationQuaternion = existing.rotationQuaternion?.clone();
  const rotation = existing.rotation.clone();
  const scaling = existing.scaling.clone();
  // An origin root's own isVisible is always false; carry the snapshot flag.
  const visible = appliedPlayVisibilityOf(existing) ?? existing.isVisible;
  const metadata = existing.metadata;
  existing.dispose();
  binding.spriteOverlays?.get(slotId)?.dispose();
  binding.spriteOverlays?.delete(slotId);
  invalidateSlotAnimLoad(binding, slotId);
  const rebuilt = createPlayVisual(scene, slotId, binding);
  rebuilt.position.copyFrom(position);
  if (rotationQuaternion) {
    rebuilt.rotationQuaternion = rotationQuaternion;
  } else {
    rebuilt.rotation.copyFrom(rotation);
  }
  rebuilt.scaling.copyFrom(scaling);
  if (metadata && typeof metadata === "object") {
    const identity = { ...metadata };
    for (const key of ["visualBundle", "hapticModelInstance", "hapticModelLoadKey", "disposeModelOnDespawn"]) delete identity[key];
    rebuilt.metadata = { ...identity, ...(rebuilt.metadata ?? {}) };
  }
  binding.meshes.set(slotId, rebuilt);
  applyMaterialToActorMeshes(binding, slotId, rebuilt);
  setPlayVisualVisibility(binding, rebuilt, visible);
  binding.onVisualChanged?.(slotId);
  return rebuilt;
}

export function retirePlaySlot(
  binding: SnapshotSceneBinding,
  slotId: number,
): void {
  binding.ragdoll?.retire(slotId);
  binding.outlines.delete(slotId);
  binding.deformers.delete(slotId);
  binding.fogVolumes.delete(slotId);
  binding.reflectionProbes.delete(slotId);
  binding.areaLights.get(slotId)?.dispose();
  binding.areaLights.delete(slotId);
  forgetRejectedAssignments(binding, slotId);
  cancelPendingVisualReplacement(binding, slotId);
  retireBoneAttachments(binding, slotId);
  retireSpringArmLag(binding, slotId);
  binding.meshes.get(slotId)?.dispose();
  binding.meshes.delete(slotId);
  binding.seenSlots.delete(slotId);
  binding.meshKinds.delete(slotId);
  binding.meshAssetGuids.delete(slotId);
  binding.meshParts.delete(slotId);
  binding.meshSorting.delete(slotId);
  binding.primaryComponentIds.delete(slotId);
  binding.overlayStyles.delete(slotId);
  forgetVisualAssignment(binding, slotId);
  binding.materialAssetGuids.delete(slotId);
  releaseRetainedMaterialOwners(binding, slotId, true);
  for (const key of slotKeysOf(binding.materialParameters, slotId)) {
    binding.materialParameters.delete(key);
    binding.releaseMaterialInstance?.(key);
  }
  binding.spriteOverlays?.get(slotId)?.dispose();
  binding.spriteOverlays?.delete(slotId);
  invalidateSlotAnimLoad(binding, slotId);
  binding.pendingAnimState?.delete(slotId);
  for (const key of slotKeysOf(binding.componentMaterialGuids, slotId)) {
    binding.componentMaterialGuids.delete(key);
  }
  binding.lightProps.delete(slotId);
  binding.cameraProps.delete(slotId);
  binding.skyboxProps.delete(slotId);
  binding.text3dProps.delete(slotId);
  binding.text2dProps.delete(slotId);
  binding.overlayPanelProps.delete(slotId);
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
  binding.onVisualChanged?.(slotId);
}

/** Drop world Play visuals/cameras; overlay compositor slots stay. */
export function retirePlayWorldSlots(binding: SnapshotSceneBinding): void {
  const slots = new Set<number>([
    ...binding.outlines.keys(),
    ...binding.deformers.keys(),
    ...binding.fogVolumes.keys(),
    ...binding.reflectionProbes.keys(),
    ...binding.areaLights.keys(),
    ...binding.meshes.keys(),
    ...binding.cameras.keys(),
    ...binding.lights.keys(),
    ...binding.meshKinds.keys(),
  ]);
  for (const slotId of slots) {
    if (binding.isOverlaySlot?.(slotId)) continue;
    retirePlaySlot(binding, slotId);
  }
  // Seen markers for stateless world slots must not survive into the next
  // load generation, where a reused slot id could look retireable.
  for (const slotId of [...binding.seenSlots]) {
    if (!binding.isOverlaySlot?.(slotId)) binding.seenSlots.delete(slotId);
  }
  binding.possessedCameraSlotId = null;
  binding.defaultCameraSlotId = null;
}

function snapshotSlotWantsOverlay(
  actor: ActorSlot,
  binding: SnapshotSceneBinding,
): boolean {
  return (
    (actor.flags & SNAPSHOT_FLAG_OVERLAY) === SNAPSHOT_FLAG_OVERLAY ||
    binding.isOverlaySlot?.(actor.slotId) === true
  );
}

/** Resolve ownership and membership before the pose-only pass. */
function reconcileSnapshotVisuals(
  scene: Scene,
  binding: SnapshotSceneBinding,
  snapshot: SampledSnapshot,
): void {
  const live = binding.liveSlots;
  live.clear();
  const seen = binding.seenSlots;
  const animationScenes = binding.tilemapAnimationScenes ??= new Set();
  animationScenes.clear();
  animationScenes.add(scene);
  const count = snapshot.actorCount ?? snapshot.actors.length;
  binding.snapshotMeshes.length = count;
  // World copies of all overlay slots are dropped in one pass. It also runs
  // when a later slot throws, so earlier slots keep their per-slot cleanup.
  let overlaySlots: Set<number> | undefined;
  try {
    for (let i = 0; i < count; i++) {
      const actor = snapshot.actors[i]!;
      binding.snapshotMeshes[i] = null;
      live.add(actor.slotId);
      const wantsOverlay = snapshotSlotWantsOverlay(actor, binding);
      const overlayScene = binding.sceneForSlot?.(actor.slotId) ?? null;
      if (wantsOverlay && !overlayScene) {
        seen.add(actor.slotId);
        // Until its layer is live, a world copy must not keep drawing at its
        // last pose; migration restores it once the layer Scene exists.
        const waiting = binding.meshes.get(actor.slotId);
        if (waiting?.getScene() === scene) setPlayVisualVisibility(binding, waiting, false);
        continue;
      }
      const hostScene = wantsOverlay ? overlayScene : scene;
      if (!hostScene) continue;
      animationScenes.add(hostScene);
      let mesh = binding.meshes.get(actor.slotId) ?? null;
      if (mesh && mesh.getScene() !== hostScene) {
        mesh = migratePlaySlotVisual(hostScene, binding, actor.slotId);
      }
      if (!mesh) {
        mesh = createPlayVisual(hostScene, actor.slotId, binding);
        binding.meshes.set(actor.slotId, mesh);
        applyMaterialToActorMeshes(binding, actor.slotId, mesh);
        binding.onVisualChanged?.(actor.slotId);
      }
      if (wantsOverlay) (overlaySlots ??= new Set()).add(actor.slotId);
      binding.snapshotMeshes[i] = mesh;
      // Seen only once applied: a scene lookup or visual build that throws
      // leaves a command-built visual protected from a stale buffer.
      seen.add(actor.slotId);
    }
  } finally {
    if (overlaySlots) disposeWorldOverlayLeftoverSlots(scene, overlaySlots);
  }
  for (const slotId of binding.meshes.keys()) {
    // A command-built visual not yet seen must survive a stale buffer.
    // Explicit despawn remains the removal path for these unseen slots.
    if (!live.has(slotId) && seen.has(slotId)) retirePlaySlot(binding, slotId);
  }
}

/** Apply a sample without changing caller-owned global Babylon flags. */
export function applySnapshotToScene(
  scene: Scene,
  binding: SnapshotSceneBinding,
  snapshot: SampledSnapshot,
): void {
  // Play samples the latest snapshot, so cables and water pair with its frame alone.
  sampleCableFrame(scene, snapshot.frameId);
  sampleSceneWaterFrame(scene, snapshot.frameId);
  reconcileSnapshotVisuals(scene, binding, snapshot);
  const count = snapshot.actorCount ?? snapshot.actors.length;
  // Without any light or camera there is nothing to look up for each actor.
  const hasLightsOrCameras = binding.lights.size > 0 || binding.cameras.size > 0;
  for (let i = 0; i < count; i++) {
    const actor = snapshot.actors[i]!;
    const mesh = binding.snapshotMeshes[i];
    if (!mesh) continue;
    writeActorTransform(mesh, actor);
    const fogVolumes = binding.fogVolumes.get(actor.slotId);
    if (fogVolumes) setFogVolumesVisible(scene, fogVolumes.actorId,
      (actor.flags & SNAPSHOT_FLAG_VISIBLE) === SNAPSHOT_FLAG_VISIBLE);
    binding.areaLights.get(actor.slotId)?.setWorld(mesh.getWorldMatrix());
    setPlayVisualVisibility(
      binding,
      mesh,
      (actor.flags & SNAPSHOT_FLAG_VISIBLE) === SNAPSHOT_FLAG_VISIBLE,
    );
    if (!hasLightsOrCameras) continue;
    const light = binding.lights.get(actor.slotId);
    const camera = binding.cameras.get(actor.slotId);
    // The few slots with a light or camera are the only ones worth the weak lookup.
    if ((!light && !camera) || hasActorIllumination(mesh)) continue;
    if (light) {
      const composed = composeSlotPartTransform(actor, binding, actor.slotId);
      updateAuthoredLightTransform(
        light,
        composed.position,
        composed.rotation,
      );
    }
    if (camera) {
      const composed = composeSlotPartTransform(actor, binding, actor.slotId);
      updateAuthoredCameraTransform(
        camera,
        composed.position,
        composed.rotation,
      );
    }
  }
  updateBoneAttachments(binding);
  for (const [slotId, attachment] of binding.boneAttachments) {
    if (attachment.applied) binding.areaLights.get(slotId)?.setWorld(attachment.world);
  }
  for (const [slotId, attachment] of binding.boneAttachments) {
    if (!attachment.applied) continue;
    const root = binding.meshes.get(slotId);
    if (root && hasActorIllumination(root)) continue;
    const light = binding.lights.get(slotId);
    const camera = binding.cameras.get(slotId);
    if (!light && !camera) continue;
    attachment.world.decompose(
      scratchBoneSlot.scale as Vector3,
      scratchBoneSlot.rotation as Quaternion,
      scratchBoneSlot.position as Vector3,
    );
    const composed = composeSlotPartTransform(scratchBoneSlot, binding, slotId);
    if (light) updateAuthoredLightTransform(light, composed.position, composed.rotation);
    if (camera) updateAuthoredCameraTransform(camera, composed.position, composed.rotation);
  }
  updatePlaySpringArms(binding, performance.now());
  for (const root of binding.snapshotMeshes) if (root) updateComponentIllumination(root);
  refreshPlayActiveCamera(scene, binding);
  // Camera-dependent passes wait for every camera pose, including later slots
  // and bone attachments, and for this snapshot's active camera.
  snapPlayCameraToPixelGrid(scene, binding);
  // Only the world Scene: overlay slots skip world-camera parallax.
  const activeCamera = scene.activeCamera;
  if (activeCamera) updateSceneTilemapParallax(scene, activeCamera.position);
  for (const animationScene of binding.tilemapAnimationScenes ?? []) {
    updateSceneTilemapAnimations(animationScene, binding.tilemapAnimationTimeMs ?? 0);
  }
}

export function disposeSnapshotBinding(binding: SnapshotSceneBinding): void {
  binding.ragdoll?.dispose();
  binding.outlines.clear();
  binding.deformers.clear();
  binding.fogVolumes.clear();
  binding.reflectionProbes.clear();
  binding.onVisualChanged = undefined;
  disposePendingVisualReplacements(binding);
  disposeMaterialPreparations(binding);
  disposeRejectedAssignments(binding);
  binding.tilemapAnimationScenes?.clear();
  binding.boneAttachments.clear();
  disposeSpringArmState(binding);
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
  for (const group of binding.areaLights.values()) group.dispose();
  binding.areaLights.clear();
  for (const camera of binding.cameras.values()) camera.dispose();
  binding.meshes.clear();
  binding.liveSlots.clear();
  binding.snapshotMeshes.length = 0;
  binding.seenSlots.clear();
  binding.spriteOverlays?.clear();
  binding.slotAnimationGroups?.clear();
  binding.pendingAnimState?.clear();
  releaseAllRetainedMaterialOwners(binding);
  for (const key of binding.materialParameters.keys()) binding.releaseMaterialInstance?.(key);
  binding.materialParameters.clear();
  binding.componentMaterialGuids.clear();
  binding.materialAssetGuids.clear();
  binding.slotAnimLoads?.clear();
  binding.slotAnimEpoch?.clear();
  binding.lights.clear();
  binding.cameras.clear();
  binding.lightProps.clear();
  binding.cameraProps.clear();
  binding.meshKinds.clear();
  binding.meshAssetGuids.clear();
  binding.meshParts.clear();
  binding.meshSorting.clear();
  binding.primaryComponentIds.clear();
  binding.overlayStyles.clear();
  forgetVisualAssignments(binding);
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
    scratchComposedPart.position.copyFromFloats(actor.position.x, actor.position.y, actor.position.z);
    scratchComposedPart.rotation.copyFromFloats(actor.rotation.x, actor.rotation.y, actor.rotation.z, actor.rotation.w);
    return scratchComposedPart;
  }
  composeActorComponentTransformToRef(
    actor,
    part,
    scratchComposedPart.position,
    scratchComposedPart.rotation,
  );
  return scratchComposedPart;
}

function writeActorTransform(mesh: Mesh, actor: ActorSlot): void {
  const rotation = mesh.rotationQuaternion;
  if (mesh.position.x === actor.position.x && mesh.position.y === actor.position.y && mesh.position.z === actor.position.z
    && mesh.scaling.x === actor.scale.x && mesh.scaling.y === actor.scale.y && mesh.scaling.z === actor.scale.z
    && rotation?.x === actor.rotation.x && rotation.y === actor.rotation.y && rotation.z === actor.rotation.z && rotation.w === actor.rotation.w) return;
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
  // It also lifts any freeze and recomputes once from the TRS written above.
  if (shouldFreezeStaticWorldMatrix(mesh)) {
    mesh.freezeWorldMatrix();
  } else {
    if (mesh.isWorldMatrixFrozen) unfreezeActorWorldMatrix(mesh);
    // Update off-screen casters too: active-mesh evaluation does not necessarily
    // visit them before the shadow hierarchy is queried.
    mesh.computeWorldMatrix();
  }
}
