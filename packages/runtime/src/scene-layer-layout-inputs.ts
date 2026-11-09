import type { VirtualizedItem } from "@haptic/core";
import type { Actor, ActorComponent } from "@haptic/object-model";

/**
 * What a Scene Layer's layout reads from its owners' variables. `SceneLayerLayout` builds its inputs with these and
 * `SceneLayerLayoutGate` compares one written owner against them, so both read exactly the same values.
 */
const LAYOUT_PROPERTY_KEYS = ["width", "height", "widthMode", "heightMode", "fillWeight", "gap", "horizontalAlignment", "verticalAlignment", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "scrollX", "scrollY", "scrollAxis", "visible", "enabled", "size", "text", "wrapWidth", "wrapHeight", "textureGuid", "itemClassId", "itemCount", "itemWidth", "itemHeight", "columns", "overscan", "useSafeArea", "safeLeft", "safeRight", "safeTop", "safeBottom", "insetLeft", "insetRight", "insetTop", "insetBottom"] as const;

/** A component value the layout reads; any other value counts as unset. */
const isLayoutValue = (value: unknown): boolean =>
  typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);

/** The variables of a component that its layout reads, by name. */
export function layoutProperties(component: ActorComponent): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of LAYOUT_PROPERTY_KEYS) {
    const value = component.getVariable(key);
    if (isLayoutValue(value)) properties[key] = value;
  }
  return properties;
}

/** Whether `layoutProperties(component)` would equal `recorded`, without building it. */
export function sameLayoutProperties(component: ActorComponent, recorded: Readonly<Record<string, unknown>>): boolean {
  for (const key of LAYOUT_PROPERTY_KEYS) {
    const value = component.getVariable(key);
    // A recorded value is never undefined, so an unset key compares as undefined on both sides.
    if ((isLayoutValue(value) ? value : undefined) !== recorded[key]) return false;
  }
  return true;
}

export const actorLayoutName = (actor: Actor): string => String(actor.getVariable("name") ?? "");

export function actorLayoutParentId(actor: Actor): string | null {
  const parentId = actor.getVariable("parentId");
  return typeof parentId === "string" ? parentId : null;
}

export const actorLayoutVisible = (actor: Actor): boolean =>
  actor.getVariable("visible") !== false && actor.getVariable("enabled") !== false;

/** The virtualized container and item index an actor stands for, when it is a container's item. */
export function actorVirtualItem(actor: Actor): VirtualizedItem | undefined {
  const index = actor.getVariable("itemIndex"), containerId = actor.getVariable("virtualizedContainerId");
  return typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && typeof containerId === "string"
    ? { containerId, index } : undefined;
}

/** Whether `actorVirtualItem(actor)` would equal `recorded`, without building it. */
export function sameActorVirtualItem(actor: Actor, recorded: VirtualizedItem | undefined): boolean {
  const index = actor.getVariable("itemIndex"), containerId = actor.getVariable("virtualizedContainerId");
  const item = typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && typeof containerId === "string";
  return item ? recorded?.containerId === containerId && recorded.index === index : recorded === undefined;
}
