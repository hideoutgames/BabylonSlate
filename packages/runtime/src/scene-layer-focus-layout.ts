import { isOverlayLayoutClass, overlayLayoutKey, type OverlayLayoutEntry, type OverlayLayoutRect } from "@babylonslate/core";
import type { Actor, ActorComponent, World } from "@babylonslate/object-model";
import type { SceneLayerLayout } from "./scene-layer-layout";
import { actorParentGuid } from "./actor-world-transform";

const VISUALS = new Set(["2DJoystickComponent", "2DTextureComponent", "2DMaterialComponent", "2DPanelComponent", "2DTextComponent", "2DRichTextComponent", "2DPainterComponent", "SpriteComponent", "MeshComponent"]);
/** Focus helpers use their visual attachment; the layout rectangle remains reachable outside clips. */
export function focusLayoutEntry(layout: SceneLayerLayout, world: World, actor: Actor, component: ActorComponent): OverlayLayoutEntry | undefined {
  if (!actor.sceneLayerId) return undefined;
  const entries = layout.entries(actor.sceneLayerId);
  const own = entries.get(overlayLayoutKey(actor.guid, component.guid));
  if (component.parentId) {
    const parent = actor.components.find((entry) => entry.guid === component.parentId);
    return parent && (VISUALS.has(parent.classId) || component.classId === "2DFocusTargetComponent" && isOverlayLayoutClass(parent.classId))
      ? entries.get(overlayLayoutKey(actor.guid, parent.guid)) ?? own : own;
  }
  const visual = actor.components.find((entry) => !entry.destroyed && !entry.parentId && (VISUALS.has(entry.classId) || isOverlayLayoutClass(entry.classId)));
  if (visual) return entries.get(overlayLayoutKey(actor.guid, visual.guid)) ?? own;
  const parentId = actorParentGuid(actor);
  const parent = parentId ? world.findActor(parentId) : undefined;
  if (parent && parent.sceneLayerId === actor.sceneLayerId) {
    const parentVisual = parent.components.find((entry) => !entry.destroyed && !entry.parentId && (VISUALS.has(entry.classId) || isOverlayLayoutClass(entry.classId)));
    if (parentVisual) return entries.get(overlayLayoutKey(parent.guid, parentVisual.guid)) ?? entries.get(parent.guid) ?? own;
  }
  return own ?? entries.get(actor.guid);
}

/** Reveal the innermost viewport first, then refetch changed geometry for each outer viewport. */
export function revealFocusedElement(layout: SceneLayerLayout, world: World, actor: Actor, component: ActorComponent,
  scroll: (layerId: string, actorId: string, componentId: string, deltaX: number, deltaY: number) => void,
): void {
  const layerId = actor.sceneLayerId;
  if (!layerId) return;
  const ancestors = focusLayoutEntry(layout, world, actor, component)?.scrollAncestors ?? [];
  for (const key of [...ancestors].reverse()) {
    const target = focusLayoutEntry(layout, world, actor, component);
    const viewport = layout.entries(layerId).get(key);
    if (!target || !viewport?.componentId || !viewport.scroll) continue;
    const state = viewport.scroll as typeof viewport.scroll & { viewport?: OverlayLayoutRect; scaleX?: number; scaleY?: number };
    const visible = state.viewport ?? viewport.rect;
    const x = revealDelta(target.rect.x, target.rect.width, visible.x, visible.width);
    // Vertical scrolling raises content, horizontal scrolling moves it left.
    const y = -revealDelta(target.rect.y, target.rect.height, visible.y, visible.height);
    if (x || y) scroll(layerId, viewport.actorId, viewport.componentId, x / (state.scaleX || 1), y / (state.scaleY || 1));
  }
}

function revealDelta(center: number, size: number, viewportCenter: number, viewportSize: number): number {
  const low = center - size / 2, high = center + size / 2;
  const viewportLow = viewportCenter - viewportSize / 2, viewportHigh = viewportCenter + viewportSize / 2;
  if (size > viewportSize) return center - viewportCenter;
  return low < viewportLow ? low - viewportLow : high > viewportHigh ? high - viewportHigh : 0;
}
