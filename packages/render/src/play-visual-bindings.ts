import type { Node as BabylonNode, Mesh, Scene } from "@babylonjs/core";
import type { CommandMessage } from "@haptic/bridge";
import { AreaRectLightGroup } from "./area-rect-light";
import type { CreateEngineOptions } from "./create-engine-types";
import { removeFogVolumes, upsertFogVolumes } from "./fog-volumes";
import { markLatticeComponentRoot } from "./lattice-deformer";
import { findSceneReflectionProbes, sceneReflectionProbes } from "./reflection-probes";
import type { RenderScheduler } from "./render-scheduler";
import type { SceneDeformerHost } from "./scene-deformer-host";
import type { SceneOutlineHost } from "./scene-outline-host";
import type { SceneRenderCoordinator } from "./scene-render-coordinator";
import { isSceneStreamSlotPending } from "./scene-stream-admission";
import { meshForPlayComponent, type SnapshotSceneBinding } from "./snapshot-apply";
import { visualMeshes } from "./visual-meshes";

/** What Play's per-slot visual bindings read from the Engine handle being built. */
export interface PlayVisualBindingsContext {
  options: CreateEngineOptions;
  scene: Scene;
  binding: SnapshotSceneBinding;
  deformerHost: SceneDeformerHost;
  outlineHost: SceneOutlineHost;
  scheduler: RenderScheduler;
  worldRenderer: SceneRenderCoordinator;
  /** The applied snapshot no longer matches the slots; the next frame applies it again. */
  markSnapshotStale: () => void;
}

/**
 * Play's per-slot visual bindings: deformers, outlines, fog volumes,
 * reflection probes and area lights follow each runtime slot's authored
 * records and its current root mesh. Installs `binding.onVisualChanged`.
 * Editor views keep their own sync from the scene document.
 */
export function createPlayVisualBindings({
  options,
  scene,
  binding,
  deformerHost,
  outlineHost,
  scheduler,
  worldRenderer,
  markSnapshotStale,
}: PlayVisualBindingsContext) {

  /** A Play slot's root when it renders in the world Scene: not an overlay slot or another Scene's mesh. */
  const worldSlotRoot = (slotId: number): Mesh | null => {
    const root = binding.meshes.get(slotId);
    return root && root.getScene() === scene && !binding.isOverlaySlot?.(slotId) ? root : null;
  };
  const outlineActorBySlot = new Map<number, string>();
  const deformerActorBySlot = new Map<number, string>();
  const refreshRuntimeDeformers = (slotId: number, refreshGeometry = true) => {
    if (options.editor) return;
    const root = worldSlotRoot(slotId);
    const authored = binding.deformers.get(slotId);
    const previous = deformerActorBySlot.get(slotId);
    if (previous && (!authored || previous !== authored.actorId || !root)) {
      deformerHost.removeActor(previous);
      deformerActorBySlot.delete(slotId);
    }
    if (!root) return;
    markLatticeComponentRoot(root);
    for (const part of binding.meshParts.get(slotId) ?? []) {
      const target = meshForPlayComponent(binding, slotId, part.componentId);
      if (target) markLatticeComponentRoot(target);
    }
    if (!authored) return;
    deformerHost.setActor(authored.actorId, authored.bindings,
      (id) => meshForPlayComponent(binding, slotId, id), refreshGeometry);
    deformerActorBySlot.set(slotId, authored.actorId);
  };
  const runtimeFogActorBySlot = new Map<number, string>();
  const refreshRuntimeFogVolumes = (slotId: number) => {
    if (options.editor) return;
    const root = worldSlotRoot(slotId);
    const authored = binding.fogVolumes.get(slotId);
    const previous = runtimeFogActorBySlot.get(slotId);
    if (previous && (!root || !authored || authored.actorId !== previous)) {
      removeFogVolumes(scene, previous);
      runtimeFogActorBySlot.delete(slotId);
    }
    if (!authored || !root) return;
    upsertFogVolumes(scene, authored.actorId, root, authored.bindings, !isSceneStreamSlotPending(scene, slotId));
    runtimeFogActorBySlot.set(slotId, authored.actorId);
  };
  // Play reflection probes: authored per slot on the binding, static actors from the authored play scene.
  const runtimeProbeActorBySlot = new Map<number, string>();
  let playStaticActors = new Set<string>();
  let probeRoots: { renderId: number; slots: Map<BabylonNode, number> } | null = null;
  const playProbeStatic = (mesh: BabylonNode): boolean => {
    // Captures ask once per mesh; map the slot roots once per frame.
    if (probeRoots?.renderId !== scene.getRenderId()) {
      probeRoots = { renderId: scene.getRenderId(), slots: new Map([...binding.meshes].map(([slot, root]) => [root as BabylonNode, slot])) };
    }
    for (let node: BabylonNode | null = mesh; node; node = node.parent) {
      const slot = probeRoots.slots.get(node);
      if (slot === undefined) continue;
      const actorGuid = binding.meshSorting.get(slot)?.actorGuid;
      return !!actorGuid && playStaticActors.has(actorGuid);
    }
    return false;
  };
  const refreshRuntimeReflectionProbes = (slotId: number) => {
    if (options.editor) return;
    const root = worldSlotRoot(slotId);
    const authored = binding.reflectionProbes.get(slotId);
    const previous = runtimeProbeActorBySlot.get(slotId);
    if (previous && (!root || !authored || authored.actorId !== previous)) {
      findSceneReflectionProbes(scene)?.remove(previous);
      runtimeProbeActorBySlot.delete(slotId);
    }
    if (!authored || !authored.bindings.length || !root) return;
    const probes = sceneReflectionProbes(scene);
    probes.setStaticPredicate(playProbeStatic);
    probes.upsert(authored.actorId, root, authored.bindings);
    runtimeProbeActorBySlot.set(slotId, authored.actorId);
  };
  const refreshRuntimeOutline = (slotId: number) => {
    if (options.editor) return;
    const root = worldSlotRoot(slotId);
    const authored = binding.outlines.get(slotId);
    const actorId = authored?.actorId ?? binding.meshSorting.get(slotId)?.actorGuid;
    const previous = outlineActorBySlot.get(slotId);
    if (previous && !root) {
      outlineHost.removeActor(previous); outlineActorBySlot.delete(slotId);
    }
    if (!actorId || !root) return;
    // Runtime transforms are normally world-space. If a caller attaches actor
    // roots, descendants still belong to their own actor's outline identity.
    const otherRoots = new Set([...binding.meshes.values()].filter((mesh) => mesh !== root));
    const meshes = visualMeshes(root, otherRoots);
    outlineHost.setActor(actorId, meshes, authored?.bindings ?? [], previous);
    outlineActorBySlot.set(slotId, actorId);
  };
  binding.onVisualChanged = (slotId) => {
    refreshRuntimeDeformers(slotId);
    refreshRuntimeOutline(slotId);
    refreshRuntimeFogVolumes(slotId);
    refreshRuntimeReflectionProbes(slotId);
  };

  /**
   * Applies the slot visual commands; returns false when `command` is a stale
   * deformer revision and the rest of the command pipeline must skip it.
   */
  const applyCommand = (command: CommandMessage): boolean => {

  if (command.type === "setActorOutlines") {
    const previous = binding.outlines.get(command.slotId);
    binding.outlines.set(command.slotId, { actorId: command.actorId, bindings: command.outlines });
    try { refreshRuntimeOutline(command.slotId); }
    catch (error) {
      if (previous) binding.outlines.set(command.slotId, previous);
      else binding.outlines.delete(command.slotId);
      throw error;
    }
    scheduler.invalidate("asset");
  }
  if (command.type === "setActorDeformers") {
    const previous = binding.deformers.get(command.slotId);
    if (previous?.actorId === command.actorId && previous.revision >= command.revision) return false;
    binding.deformers.set(command.slotId, { actorId: command.actorId, revision: command.revision, bindings: command.deformers });
    try { refreshRuntimeDeformers(command.slotId, false); }
    catch (error) {
      if (previous) binding.deformers.set(command.slotId, previous);
      else binding.deformers.delete(command.slotId);
      throw error;
    }
    scheduler.invalidate("asset");
  }
  if (command.type === "setReflectionProbes") {
    if (command.probes.length) binding.reflectionProbes.set(command.slotId, { actorId: command.actorId, bindings: command.probes });
    else binding.reflectionProbes.delete(command.slotId);
    refreshRuntimeReflectionProbes(command.slotId);
  }
  if (command.type === "recaptureReflectionProbes") findSceneReflectionProbes(scene)?.markDirty(true);
  if (command.type === "setFogVolumes") {
    markSnapshotStale();
    binding.fogVolumes.set(command.slotId, { actorId: command.actorId, bindings: command.volumes });
    refreshRuntimeFogVolumes(command.slotId);
    scheduler.invalidate("asset");
  }
  if (command.type === "setAreaLights") {
    let group = binding.areaLights.get(command.slotId);
    let changed = false;
    if (command.lights.length) {
      if (!group) { group = new AreaRectLightGroup(scene, `playAreaLight:${command.slotId}`); binding.areaLights.set(command.slotId, group); }
      changed = group.update(command.lights, binding.areaEmissions);
      const mesh = binding.meshes.get(command.slotId);
      if (mesh) group.setWorld(mesh.getWorldMatrix());
    } else if (group) { group.dispose(); binding.areaLights.delete(command.slotId); changed = true; }
    if (changed) {
      markSnapshotStale();
      worldRenderer.invalidate();
      scheduler.invalidate("asset");
    }
  }
    return true;
  };

  return {
    applyCommand,
    /** The authored Play scene's static actors, which reflection probe captures keep. */
    setStaticActors: (actors: Set<string>) => {
      playStaticActors = actors;
    },
  };
}
