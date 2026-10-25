import type { Material, Mesh, Scene } from "@babylonjs/core";
import type { CommandMessage } from "@haptic/bridge";
import { applyMaterialBounds } from "./material-bounds";
import { restoreAlbedoMaterial } from "./mesh-assets";
import { applyModelMaterialSlots } from "./model-preview";
import { isTilemapChunkMesh } from "./tilemap-mesh";
import {
  componentIdForPlayMesh,
  isMesh,
  slotKeysOf,
  type SceneNode,
  type SnapshotSceneBinding,
} from "./snapshot-binding";

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
  const instanceKey = materialInstanceKey(command.slotId, componentId);
  const previous = componentId
    ? binding.componentMaterialGuids.get(instanceKey)
    : binding.materialAssetGuids.get(command.slotId);
  const restart = pendingMaterialPreparations.get(binding)?.get(command.slotId);
  let provisionalGuid: string | undefined;
  if (previous !== command.materialAssetGuid) {
    const privateGuid = binding.materialParameters.get(instanceKey)?.materialAssetGuid;
    if (restart) {
      // Keep the actual predecessor owner; a superseded candidate's different
      // GUID can retire after its native users have been cancelled below.
      if (privateGuid && retainedMaterialOwners.get(binding)?.get(command.slotId)?.get(instanceKey) !== privateGuid) provisionalGuid = privateGuid;
    } else binding.releaseMaterialInstance?.(instanceKey);
    binding.materialParameters.delete(instanceKey);
  }
  if (componentId) {
    binding.componentMaterialGuids.set(
      `${command.slotId}|${componentId}`,
      command.materialAssetGuid,
    );
  } else {
    binding.materialAssetGuids.set(command.slotId, command.materialAssetGuid);
  }
  if (restart) {
    try { restart(); } finally {
      if (provisionalGuid) binding.releaseMaterialInstance?.(instanceKey, provisionalGuid);
    }
    return;
  }
  const root = binding.meshes.get(command.slotId);
  if (!root) return;
  // An empty id records a whole-actor assignment above, so it is not scoped.
  applyMaterialToActorMeshes(binding, command.slotId, root, componentId || undefined);
}

function materialInstanceKey(
  slotId: number,
  componentId?: string | null,
): string {
  return `${slotId}|${componentId ?? ""}`;
}

function assignedMaterialGuid(
  binding: SnapshotSceneBinding,
  slotId: number,
  componentId: string | null | undefined,
): string | null | undefined {
  const key = materialInstanceKey(slotId, componentId);
  return componentId && binding.componentMaterialGuids.has(key)
    ? binding.componentMaterialGuids.get(key)
    : binding.materialAssetGuids.get(slotId);
}

/** Runtime commands only mutate the captured material assignment on the target component. */
export function applySetMaterialParameter(
  binding: SnapshotSceneBinding,
  command: Extract<CommandMessage, { type: "setMaterialParameter" }>,
): void {
  const key = materialInstanceKey(command.slotId, command.componentId);
  const primaryId = binding.primaryComponentIds.get(command.slotId);
  const parts = binding.meshParts.get(command.slotId);
  if (command.componentId && (primaryId || parts?.length)) {
    if (
      command.componentId !== primaryId &&
      !parts?.some((part) => part.componentId === command.componentId)
    )
      return;
  }
  const assignedGuid = assignedMaterialGuid(
    binding,
    command.slotId,
    command.componentId,
  );
  if (assignedGuid !== command.materialAssetGuid) return;
  if (
    binding.validateMaterialParameter?.(
      command.materialAssetGuid,
      command.parameterName,
      command.parameter,
    ) === false
  )
    return;
  let parameters = binding.materialParameters.get(key);
  if (!parameters) {
    parameters = {
      materialAssetGuid: command.materialAssetGuid,
      values: new Map(),
    };
    binding.materialParameters.set(key, parameters);
  }
  parameters.values.set(command.parameterName, command.parameter);
  const restart = pendingMaterialPreparations.get(binding)?.get(command.slotId);
  if (restart) { restart(); return; }
  const root = binding.meshes.get(command.slotId);
  // A component's private values reach only its own meshes; an empty id is a whole-actor write.
  if (root) applyMaterialToActorMeshes(binding, command.slotId, root, command.componentId || undefined);
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
export function applyLoadedModelMaterials(
  binding: SnapshotSceneBinding,
  slotId: number,
  assetGuid: string,
  root: Mesh,
): void {
  const payload = binding.modelPayloads?.get(assetGuid);
  if (payload) {
    applyModelMaterialSlots(root, payload.materialSlots, (guid) =>
      resolveAssignedMaterial(binding, slotId, root, guid),
    );
  }
  applyMaterialToActorMeshes(binding, slotId, root);
}

export function wantsOverlayUnlitMaterial(
  binding: SnapshotSceneBinding,
  slotId: number,
): boolean {
  if (binding.isOverlaySlot?.(slotId) === true) return true;
  switch (binding.meshKinds.get(slotId)) {
    case "2dtexture":
    case "2dmaterial":
    case "2dbutton":
    case "2dpanel":
    case "2dcontrol":
    case "2djoystick":
    case "2dpainter":
    case "2dtext":
    case "2drichtext":
      return true;
    default:
      return false;
  }
}

function resolveAssignedMaterial(
  binding: SnapshotSceneBinding,
  slotId: number,
  root: Mesh,
  guid: string,
  componentId: string | null = componentIdForPlayMesh(root, slotId, binding),
): Material | null {
  const host = root.getScene();
  const overlay = wantsOverlayUnlitMaterial(binding, slotId);
  let instanceKey = materialInstanceKey(slotId, componentId);
  let parameters = binding.materialParameters.get(instanceKey);
  if (!parameters && !binding.componentMaterialGuids.has(instanceKey)) {
    instanceKey = materialInstanceKey(slotId);
    parameters = binding.materialParameters.get(instanceKey);
  }
  return (
    binding.resolveMaterial?.(guid, {
      scene: host,
      ...(overlay ? { unlit: true } : {}),
      ...(parameters?.materialAssetGuid === guid
        ? { instanceKey, parameters: parameters.values }
        : {}),
    }) ?? null
  );
}

/**
 * Bind the recorded Materials to every mesh of a slot's visual. `onlyComponentId`
 * limits the pass to that component's meshes (including imported children and
 * any added after realization, which are found by the walk): a component's own
 * assignment cannot change what another component's meshes resolve to, so the
 * other meshes are not re-resolved.
 */
export function applyMaterialToActorMeshes(
  binding: SnapshotSceneBinding,
  slotId: number,
  root: Mesh,
  onlyComponentId?: string,
): void {
  const targets: Mesh[] = [root, ...root.getChildMeshes().filter(isMesh)];
  const components = new Map<SceneNode, string | null>();
  for (const target of targets) {
    // Text Materials are composed with glyph coverage by the text builder.
    if (target.metadata?.text2d || target.metadata?.text2dGlyph) continue;
    if (isTilemapChunkMesh(target)) continue;
    const componentId = componentIdForPlayMesh(target, slotId, binding, components);
    if (onlyComponentId !== undefined && componentId !== onlyComponentId) continue;
    const guid = assignedMaterialGuid(binding, slotId, componentId);
    if (guid === null) {
      if (!restoreAlbedoMaterial(target)) target.material = null;
      continue;
    }
    if (!guid) continue;
    const material = resolveAssignedMaterial(
      binding,
      slotId,
      root,
      guid,
      componentId,
    );
    if (material) { target.material = material; applyMaterialBounds(target); }
  }
}

// A material command supersedes preparation for the exact pending visual, not
// the already published model generation or another incarnation of this slot.
const pendingMaterialPreparations = new WeakMap<SnapshotSceneBinding, Map<number, () => void>>();

/** The binding's stored map (created on first use) of slot preparations that material commands restart. */
export function materialPreparationRestarts(binding: SnapshotSceneBinding): Map<number, () => void> {
  const refreshes = pendingMaterialPreparations.get(binding) ?? new Map<number, () => void>();
  pendingMaterialPreparations.set(binding, refreshes);
  return refreshes;
}

export function forgetMaterialPreparation(binding: SnapshotSceneBinding, slotId: number): void {
  pendingMaterialPreparations.get(binding)?.delete(slotId);
}

export function disposeMaterialPreparations(binding: SnapshotSceneBinding): void {
  pendingMaterialPreparations.delete(binding);
}

const retainedMaterialOwners = new WeakMap<SnapshotSceneBinding, Map<number, Map<string, string>>>();

export function retainWorkingMaterialOwners(binding: SnapshotSceneBinding, slotId: number, hasPredecessor = true): void {
  const slots = retainedMaterialOwners.get(binding) ?? new Map<number, Map<string, string>>();
  retainedMaterialOwners.set(binding, slots);
  if (slots.has(slotId)) return;
  slots.set(slotId, new Map(hasPredecessor ? [...slotKeysOf(binding.materialParameters, slotId)]
    .map((key) => [key, binding.materialParameters.get(key)!.materialAssetGuid]) : []));
}

export function releaseRetainedMaterialOwners(binding: SnapshotSceneBinding, slotId: number, retiringSlot = false): void {
  const slots = retainedMaterialOwners.get(binding);
  const owners = slots?.get(slotId);
  for (const [key, guid] of owners ?? []) {
    const current = binding.materialParameters.get(key);
    if (retiringSlot) {
      // Ordinary parameter-owner teardown below releases all GUIDs for this key.
      if (!current) binding.releaseMaterialInstance?.(key);
    } else if (current?.materialAssetGuid !== guid) binding.releaseMaterialInstance?.(key, guid);
  }
  slots?.delete(slotId);
  if (!slots?.size) retainedMaterialOwners.delete(binding);
}

/** Whether a superseded replacement left material owners retained for the slot. */
export function hasRetainedMaterialOwners(binding: SnapshotSceneBinding, slotId: number): boolean {
  return retainedMaterialOwners.get(binding)?.has(slotId) === true;
}

/** Binding teardown: release every slot's retained owners as a retiring slot. */
export function releaseAllRetainedMaterialOwners(binding: SnapshotSceneBinding): void {
  for (const slotId of retainedMaterialOwners.get(binding)?.keys() ?? []) releaseRetainedMaterialOwners(binding, slotId, true);
}

/** Drop the slot's component Materials and parameters whose component an assignment no longer has. */
export function retireRemovedComponentMaterials(
  binding: SnapshotSceneBinding,
  slotId: number,
  componentIds: ReadonlySet<string> | null,
): void {
  if (!componentIds) return;
  const prefix = `${slotId}|`;
  // Only this slot's keys; the copy keeps iteration stable while the loop deletes.
  const keys = new Set([
    ...slotKeysOf(binding.componentMaterialGuids, slotId),
    ...slotKeysOf(binding.materialParameters, slotId),
  ]);
  for (const key of keys) {
    const id = key.slice(prefix.length);
    if (!id || componentIds.has(id)) continue;
    binding.componentMaterialGuids.delete(key);
    binding.materialParameters.delete(key);
    binding.releaseMaterialInstance?.(key);
    retainedMaterialOwners.get(binding)?.get(slotId)?.delete(key);
  }
}
