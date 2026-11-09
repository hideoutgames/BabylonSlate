import { resolveOverlayLayout, type OverlaySafeAreaInsets, type VirtualizedItem, type OverlayLayoutEntry, type OverlayLayoutResult, type SerializedActor, type SerializedTransform, type Transform } from "@haptic/core";
import type { Actor, ActorComponent } from "@haptic/object-model";
import { samePlainData } from "./plain-data";
import { SceneLayerLayoutGate } from "./scene-layer-layout-gate";
import { actorLayoutName, actorLayoutParentId, actorLayoutVisible, actorVirtualItem, layoutProperties } from "./scene-layer-layout-inputs";

type CachedPose = { authored: SerializedTransform; applied: SerializedTransform };
const serialize = (t: Transform): SerializedTransform => ({ position: [t.position.x, t.position.y, t.position.z], rotation: [t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w], scale: [t.scale.x, t.scale.y, t.scale.z] });
const live = (t: SerializedTransform): Transform => ({ position: { x: t.position[0], y: t.position[1], z: t.position[2] }, rotation: { x: t.rotation[0], y: t.rotation[1], z: t.rotation[2], w: t.rotation[3] }, scale: { x: t.scale[0], y: t.scale[1], z: t.scale[2] } });


/** Retains design poses while arranging; script transform edits replace the design pose. */
export class SceneLayerLayout {
  private poses = new WeakMap<Actor | ActorComponent, CachedPose>();
  /** Each layer's last laid-out inputs; layout reads but never mutates them. */
  private readonly inputs = new Map<string, unknown[]>();
  private readonly results = new Map<string, OverlayLayoutResult>();
  private readonly owners = new Map<string, Array<Actor | ActorComponent>>();
  /** Recognises an unchanged layer before its inputs are built; see `SceneLayerLayoutGate`. */
  private readonly gate = new SceneLayerLayoutGate();
  entries(layerId: string): ReadonlyMap<string, OverlayLayoutEntry> { return this.results.get(layerId)?.entries ?? new Map(); }
  /** The design pose: reused while the live pose is still the one layout applied. */
  private authored(target: Actor | ActorComponent): SerializedTransform {
    const current = serialize(target.transform), cached = this.poses.get(target);
    if (cached && samePlainData(cached.applied, current)) return cached.authored;
    this.poses.set(target, { authored: current, applied: current });
    return current;
  }
  update(layerId: string, actors: readonly Actor[], pixelsPerUnit: number, texturePixelSizes: Readonly<Record<string, { width: number; height: number }>> = {}, safeAreaInsets: Partial<OverlaySafeAreaInsets> = {}): OverlayLayoutResult | null {
    // Nothing the layout reads has changed since it last ran: skip building its inputs.
    if (this.gate.unchanged(layerId, actors, this.owners.get(layerId), pixelsPerUnit, texturePixelSizes, safeAreaInsets)) return null;
    const owners = actors.filter(actor => actor.sceneLayerId === layerId && !actor.destroyed).flatMap(actor => [actor, ...actor.components.filter(component => !component.destroyed)]);
    const source: SerializedActor[] = actors.filter(a => a.sceneLayerId === layerId && !a.destroyed).map(a => ({
      id: a.guid, classId: a.classId, name: actorLayoutName(a), parentId: actorLayoutParentId(a),
      transform: this.authored(a), visible: actorLayoutVisible(a), locked: false, folderId: null,
      components: a.components.filter(c => !c.destroyed).map(c => ({ id: c.guid, classId: c.classId, parentId: c.parentId, transform: this.authored(c), properties: layoutProperties(c) })),
    }));
    const virtualItems: Record<string, VirtualizedItem> = {};
    for (const actor of actors) {
      const item = actor.sceneLayerId === layerId ? actorVirtualItem(actor) : undefined;
      if (item) virtualItems[actor.guid] = item;
    }
    const sizes = source.flatMap(actor => actor.components.flatMap(component => {
      const guid = component.properties.textureGuid;
      if (typeof guid !== "string") return [];
      const size = texturePixelSizes[guid];
      return [[guid, size?.width, size?.height]];
    }));
    const inputs = [source, pixelsPerUnit, sizes, { ...safeAreaInsets }, virtualItems];
    const previousInputs = this.inputs.get(layerId);
    const previousOwners = this.owners.get(layerId);
    if (previousInputs && previousOwners && samePlainData(previousInputs, inputs) && previousOwners.length === owners.length && owners.every((owner, index) => previousOwners[index] === owner)) {
      // Equal to what was laid out, so what was read now stands in for it.
      this.gate.record(layerId, actors, previousOwners, pixelsPerUnit, texturePixelSizes, safeAreaInsets, source, virtualItems);
      return null;
    }
    const result = resolveOverlayLayout(source, { pixelsPerUnit, safeAreaInsets, virtualItems, textureSize: (guid) => texturePixelSizes[guid], includeUnmanagedBounds: true });
    const byId = new Map(actors.map(a => [a.guid, a]));
    const apply = (target: Actor | ActorComponent, transform: SerializedTransform) => {
      target.transform = live(transform);
      const cache = this.poses.get(target);
      if (cache) cache.applied = serialize(target.transform);
    };
    for (const actor of result.actors) {
      const target = byId.get(actor.id); if (!target) continue;
      apply(target, actor.transform);
      const components = new Map(target.components.map(c => [c.guid, c]));
      for (const c of actor.components) { const component = components.get(c.id); if (component && c.transform) apply(component, c.transform); }
    }
    this.results.set(layerId, result);
    this.inputs.set(layerId, inputs);
    this.owners.set(layerId, owners);
    this.gate.record(layerId, actors, owners, pixelsPerUnit, texturePixelSizes, safeAreaInsets, source, virtualItems);
    return result;
  }
  remove(layerId: string): void {
    this.results.delete(layerId); this.inputs.delete(layerId); this.owners.delete(layerId); this.gate.remove(layerId);
  }
  clear(): void { this.results.clear(); this.inputs.clear(); this.owners.clear(); this.gate.clear(); this.poses = new WeakMap(); }
}
