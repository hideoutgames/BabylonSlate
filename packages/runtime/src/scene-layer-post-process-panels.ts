import type { CommandMessage, SceneLayerPostProcessPanelPayload } from "@haptic/bridge";
import {
  parsePostProcessingPanelProperties,
  postProcessingPanelActive,
  POST_PROCESSING_PANEL_CLASS_ID,
  type MaterialParameterValue,
} from "@haptic/core";
import { MaterialObject, type Actor, type ActorComponent, type World } from "@haptic/object-model";
import { actorParentGuid } from "./actor-world-transform";
import { componentOwners } from "./world-component-index";
import { sceneLayerActors } from "./world-layer-index";

export interface SceneLayerPostProcessPanelsHost {
  world: World;
  slot(actor: Actor): number | undefined;
  /** The values a pass starts with: its Material Instance overrides and the script writes so far (`captureOverrides`). */
  parameters(material: MaterialObject): Record<string, MaterialParameterValue> | null;
  /** The renderer is handed the pass again: the next write of each parameter is sent (`resend`). */
  resend(material: MaterialObject): void;
  emit(command: CommandMessage): void;
}

/** An actor's first enabled Post Processing Panel with a Material, if any. */
function activePanel(actor: Actor): ActorComponent | null {
  if (actor.destroyed || !actor.sceneLayerId) return null;
  for (const component of actor.components) {
    if (component.destroyed || component.classId !== POST_PROCESSING_PANEL_CLASS_ID) continue;
    const properties = parsePostProcessingPanelProperties({
      enabled: component.getVariable("enabled"),
      materialGuid: component.getVariable("materialGuid"),
    });
    if (postProcessingPanelActive(properties)) return component;
  }
  return null;
}

/**
 * The Scene Layer instances' Post Processing Panels, sent to the compositor as `sceneLayerPostProcessPanels`: per
 * layer, each enabled panel with a Material, the slots of the actors that draw into it (its own actor and every
 * descendant no nearer such panel holds) and the panel holding it, inner panels first. A panel switched off or
 * without a Material is not sent, so its actors draw as under any parent. A layer is sent again only when that list
 * changes; a world without panels pays one index lookup per publish.
 */
export class SceneLayerPostProcessPanels {
  private readonly host: SceneLayerPostProcessPanelsHost;
  /** Per layer, the list last sent (without parameter values, which the panels' Material Objects send themselves). */
  private readonly sent = new Map<string, string>();
  /** The structure and panel settings the last sync read; unchanged, nothing is read again. */
  private readRevision = -1;
  private readSignature = "";

  constructor(host: SceneLayerPostProcessPanelsHost) {
    this.host = host;
  }

  sync(): void {
    const world = this.host.world;
    const owners = componentOwners(world, POST_PROCESSING_PANEL_CLASS_ID);
    if (owners.length === 0 && this.sent.size === 0) return;
    const panels = new Map<Actor, ActorComponent>();
    let signature = "";
    for (const actor of owners) {
      const panel = activePanel(actor);
      if (!panel) continue;
      panels.set(actor, panel);
      signature += `${actor.guid}:${panel.guid}:${String(panel.getVariable("materialGuid"))};`;
    }
    if (world.structuralRevision === this.readRevision && signature === this.readSignature) return;
    let complete = true;
    const layers = new Map<string, Array<{ payload: SceneLayerPostProcessPanelPayload; component: ActorComponent }>>();
    const layerIds = new Set<string>();
    for (const actor of panels.keys()) layerIds.add(actor.sceneLayerId!);
    for (const layerId of layerIds) {
      const result = this.layerPanels(layerId, panels);
      if (!result.complete) complete = false;
      layers.set(layerId, result.payloads);
    }
    // A content actor still without a render slot is read again on the next publish.
    this.readRevision = complete ? world.structuralRevision : -1;
    this.readSignature = signature;
    for (const [layerId, entries] of layers) {
      const key = JSON.stringify(entries.map(({ payload }) =>
        [payload.slotId, payload.componentId, payload.materialGuid, payload.contentSlotIds, payload.parentSlotId]));
      if (this.sent.get(layerId) === key) continue;
      this.sent.set(layerId, key);
      for (const { payload, component } of entries) {
        const material = component.getVariable("materialObject");
        if (material instanceof MaterialObject) {
          payload.parameters = this.host.parameters(material) ?? {};
          this.host.resend(material);
        }
      }
      this.host.emit({ type: "sceneLayerPostProcessPanels", layerId, panels: entries.map(({ payload }) => payload) });
    }
    for (const layerId of [...this.sent.keys()]) {
      if (layers.has(layerId)) continue;
      this.sent.delete(layerId);
      if (world.findSceneLayer(layerId)) this.host.emit({ type: "sceneLayerPostProcessPanels", layerId, panels: [] });
    }
  }

  /** A removed layer's panels went with it. */
  forget(layerId: string): void {
    this.sent.delete(layerId);
    this.readRevision = -1;
  }

  private layerPanels(layerId: string, panels: ReadonlyMap<Actor, ActorComponent>): {
    payloads: Array<{ payload: SceneLayerPostProcessPanelPayload; component: ActorComponent }>; complete: boolean;
  } {
    const world = this.host.world;
    const actors = sceneLayerActors(world, layerId);
    /** Each actor's nearest panel actor, itself included; null under none. */
    const holder = new Map<Actor, Actor | null>();
    const holderOf = (actor: Actor): Actor | null => {
      const path: Actor[] = [];
      let found: Actor | null = null;
      for (let current: Actor | undefined = actor; current && !current.destroyed;) {
        if (holder.has(current)) { found = holder.get(current) ?? null; break; }
        path.push(current);
        if (panels.has(current)) { found = current; break; }
        const parentId = actorParentGuid(current);
        const parent: Actor | undefined = parentId ? world.findActor(parentId) : undefined;
        // A parent cycle or a parent in another layer ends the walk.
        if (!parent || parent.sceneLayerId !== layerId || path.includes(parent)) break;
        current = parent;
      }
      for (const visited of path) holder.set(visited, found);
      return found;
    };
    const content = new Map<Actor, number[]>();
    let complete = true;
    for (const actor of actors) {
      if (actor.destroyed) continue;
      const owner = holderOf(actor);
      if (!owner) continue;
      const slotId = this.host.slot(actor);
      if (slotId === undefined) { complete = false; continue; }
      let slots = content.get(owner);
      if (!slots) content.set(owner, slots = []);
      slots.push(slotId);
    }
    /** The panel actor holding a panel actor: the nearest panel above its parent. */
    const outerOf = (panel: Actor): Actor | null => {
      const parentId = actorParentGuid(panel);
      const parent = parentId ? world.findActor(parentId) : undefined;
      const outer = parent && parent.sceneLayerId === layerId ? holderOf(parent) : null;
      return outer === panel ? null : outer;
    };
    const depths = new Map<Actor, number>();
    const depthOf = (panel: Actor): number => {
      const known = depths.get(panel);
      if (known !== undefined) return known;
      depths.set(panel, 0);
      const outer = outerOf(panel);
      const depth = outer ? depthOf(outer) + 1 : 0;
      depths.set(panel, depth);
      return depth;
    };
    const entries: Array<{ payload: SceneLayerPostProcessPanelPayload; component: ActorComponent; depth: number; order: number }> = [];
    let order = 0;
    for (const actor of actors) {
      const component = panels.get(actor);
      if (!component) continue;
      const slotId = this.host.slot(actor);
      if (slotId === undefined) { complete = false; continue; }
      const outer = outerOf(actor);
      const depth = depthOf(actor);
      entries.push({
        component,
        depth,
        order: order++,
        payload: {
          slotId,
          componentId: component.guid,
          materialGuid: String(component.getVariable("materialGuid")).trim(),
          parameters: {},
          contentSlotIds: content.get(actor) ?? [slotId],
          parentSlotId: outer ? this.host.slot(outer) ?? null : null,
        },
      });
    }
    // Inner panels first: an outer panel's content draws an inner panel's result.
    entries.sort((a, b) => b.depth - a.depth || a.order - b.order);
    return { payloads: entries.map(({ payload, component }) => ({ payload, component })), complete };
  }
}
