import { resolveOverlayLayout, type OverlayLayoutEntry, type OverlayLayoutResult, type SerializedActor, type SerializedTransform, type Transform } from "@babylonslate/core";
import type { Actor, ActorComponent } from "@babylonslate/object-model";

type CachedPose = { authored: SerializedTransform; applied: string };
const LAYOUT_PROPERTY_KEYS = ["width", "height", "widthMode", "heightMode", "fillWeight", "gap", "horizontalAlignment", "verticalAlignment", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "scrollX", "scrollY", "scrollAxis", "visible", "enabled", "size", "text", "wrapWidth", "wrapHeight", "textureGuid"] as const;
function layoutProperties(component: ActorComponent): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of LAYOUT_PROPERTY_KEYS) {
    const value = component.getVariable(key);
    if (typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) properties[key] = value;
  }
  return properties;
}
const serialize = (t: Transform): SerializedTransform => ({ position: [t.position.x, t.position.y, t.position.z], rotation: [t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w], scale: [t.scale.x, t.scale.y, t.scale.z] });
const live = (t: SerializedTransform): Transform => ({ position: { x: t.position[0], y: t.position[1], z: t.position[2] }, rotation: { x: t.rotation[0], y: t.rotation[1], z: t.rotation[2], w: t.rotation[3] }, scale: { x: t.scale[0], y: t.scale[1], z: t.scale[2] } });

/** Retains design poses while arranging; script transform edits replace the design pose. */
export class SceneLayerLayout {
  private poses = new WeakMap<Actor | ActorComponent, CachedPose>();
  private readonly signatures = new Map<string, string>();
  private readonly results = new Map<string, OverlayLayoutResult>();
  private readonly owners = new Map<string, Array<Actor | ActorComponent>>();
  entries(layerId: string): ReadonlyMap<string, OverlayLayoutEntry> { return this.results.get(layerId)?.entries ?? new Map(); }
  private authored(target: Actor | ActorComponent): SerializedTransform {
    const current = serialize(target.transform), signature = JSON.stringify(current), cached = this.poses.get(target);
    if (cached && cached.applied === signature) return structuredClone(cached.authored);
    this.poses.set(target, { authored: current, applied: signature });
    return structuredClone(current);
  }
  update(layerId: string, actors: readonly Actor[], pixelsPerUnit: number, texturePixelSizes: Readonly<Record<string, { width: number; height: number }>> = {}): OverlayLayoutResult | null {
    const owners = actors.filter(actor => actor.sceneLayerId === layerId && !actor.destroyed).flatMap(actor => [actor, ...actor.components.filter(component => !component.destroyed)]);
    const source: SerializedActor[] = actors.filter(a => a.sceneLayerId === layerId && !a.destroyed).map(a => ({
      id: a.guid, classId: a.classId, name: String(a.getVariable("name") ?? ""), parentId: typeof a.getVariable("parentId") === "string" ? String(a.getVariable("parentId")) : null,
      transform: this.authored(a), visible: a.getVariable("visible") !== false && a.getVariable("enabled") !== false, locked: false, folderId: null,
      components: a.components.filter(c => !c.destroyed).map(c => ({ id: c.guid, classId: c.classId, parentId: c.parentId, transform: this.authored(c), properties: layoutProperties(c) })),
    }));
    const sizes = source.flatMap(actor => actor.components.flatMap(component => typeof component.properties.textureGuid === "string" ? [[component.properties.textureGuid, texturePixelSizes[component.properties.textureGuid]]] : []));
    const signature = JSON.stringify([source, pixelsPerUnit, sizes]);
    const previousOwners = this.owners.get(layerId);
    if (this.signatures.get(layerId) === signature && previousOwners?.length === owners.length && owners.every((owner, index) => previousOwners[index] === owner)) return null;
    const result = resolveOverlayLayout(source, { pixelsPerUnit, textureSize: (guid) => texturePixelSizes[guid] });
    const byId = new Map(actors.map(a => [a.guid, a]));
    const apply = (target: Actor | ActorComponent, transform: SerializedTransform) => {
      target.transform = live(transform);
      const cache = this.poses.get(target);
      if (cache) cache.applied = JSON.stringify(transform);
    };
    for (const actor of result.actors) {
      const target = byId.get(actor.id); if (!target) continue;
      apply(target, actor.transform);
      const components = new Map(target.components.map(c => [c.guid, c]));
      for (const c of actor.components) { const component = components.get(c.id); if (component && c.transform) apply(component, c.transform); }
    }
    this.results.set(layerId, result);
    this.signatures.set(layerId, signature);
    this.owners.set(layerId, owners);
    return result;
  }
  remove(layerId: string): void {
    this.results.delete(layerId); this.signatures.delete(layerId); this.owners.delete(layerId);
  }
  clear(): void { this.results.clear(); this.signatures.clear(); this.owners.clear(); this.poses = new WeakMap(); }
}
