/**
 * The Z-Order of new actors in a 2D host: a Scene whose viewport is 2D, or a
 * Scene Layer tab. Placing, an Outliner row dragged onto the viewport, Paste
 * and Duplicate all add actors through `addNewSceneActors`.
 */
import {
  actorCameraComponent,
  isSceneLayerAnchorActor,
  UI_CONTROL_2D_CLASS_IDS,
  type SerializedActor,
  type SerializedScene,
  type SerializedTransform,
} from "@haptic/core";
import { authoredActorWorldTransform } from "@haptic/render";
import type { StackNewActors2D } from "@haptic/vfs";
import { depthFromZOrder, zOrderFromDepth } from "./transform-property-rows";

/** Components that draw in a 2D view. Cameras, lights, audio, colliders and volumes do not. */
const DRAWN_2D_COMPONENT_CLASS_IDS: ReadonlySet<string> = new Set([
  "MeshComponent",
  "DynamicRuntimeMeshComponent",
  "SpriteComponent",
  "TilemapComponent",
  "Text3DComponent",
  "ParticleComponent",
  "CableComponent",
  "2DPainterComponent",
  "2DTextComponent",
  "2DRichTextComponent",
  "2DTextureComponent",
  "2DMaterialComponent",
  "2DPanelComponent",
  "2DButtonComponent",
  "2DJoystickComponent",
  ...UI_CONTROL_2D_CLASS_IDS,
]);

/** A Scene Layer tab, or a Scene whose viewport is 2D: depth is a Z-Order there. */
export function isFlatScene(scene: Pick<SerializedScene, "viewportMode" | "overlayEditor">): boolean {
  return scene.overlayEditor === true || scene.viewportMode === "2d";
}

/** Whether Stack New 2D Actors applies to `scene`. */
export function stacksNewActors(
  scene: Pick<SerializedScene, "viewportMode" | "overlayEditor">,
  setting: StackNewActors2D,
): boolean {
  if (!isFlatScene(scene)) return false;
  return setting === "both" || setting === (scene.overlayEditor === true ? "sceneLayers" : "scenes");
}

/**
 * Where a copy of `source` dropped at `position` lands: in 2D the drop sets X
 * and Y and the copy keeps the source's world depth, its Z-Order; in 3D the
 * drop position is used whole.
 */
export function droppedCopyPosition(
  scene: SerializedScene,
  source: SerializedActor,
  position: readonly [number, number, number],
): [number, number, number] {
  if (!isFlatScene(scene)) return [position[0], position[1], position[2]];
  return [position[0], position[1], authoredActorWorldTransform(scene.actors, source).position[2]];
}

/** World matrices can leave rounding noise; a Z-Order is read to a millionth. */
const roundOrder = (order: number) => Math.round(order * 1e6) / 1e6;

/** The highest world Z-Order among actors that draw; null when none does. */
function highestDrawnZOrder(actors: readonly SerializedActor[]): number | null {
  let highest: number | null = null;
  for (const actor of actors) {
    if (!actor.components.some((component) => DRAWN_2D_COMPONENT_CLASS_IDS.has(component.classId))) continue;
    const order = roundOrder(zOrderFromDepth(authoredActorWorldTransform(actors, actor).position[2]));
    highest = highest === null ? order : Math.max(highest, order);
  }
  return highest;
}

/**
 * Local Z that puts a child at world `depth` under `parent`. 2D turns only
 * about Z, so the parent's world Z and Z scale are the whole mapping.
 */
function localDepth(depth: number, parent: SerializedTransform): number {
  const scale = parent.scale[2];
  return scale === 0 ? 0 : (depth - parent.position[2]) / scale;
}

/**
 * `scene` with new actors added in creation order. `copies` marks Paste,
 * Duplicate and an Outliner row dropped on the viewport; otherwise the actors
 * were placed. In a 2D Scene or a Scene Layer, each new actor whose parent is
 * not new too:
 * - with Stack New 2D Actors on for that host, goes one Z-Order above the
 *   highest actor that draws (0 when none does), the next one above it;
 * - otherwise takes Z-Order 0 when placed, and keeps its own when copied.
 * Children of new parents keep their offsets; Cameras keep their Z, which in
 * 2D is their distance from the scene; Scene Layer anchors stay put. A 3D
 * Scene adds the actors as they are.
 */
export function addNewSceneActors(
  scene: SerializedScene,
  actors: readonly SerializedActor[],
  options: { copies: boolean; stack: StackNewActors2D },
): SerializedScene {
  const stacking = stacksNewActors(scene, options.stack);
  if (!isFlatScene(scene) || (options.copies && !stacking)) {
    return { ...scene, actors: [...scene.actors, ...actors] };
  }
  const ids = new Set(actors.map((actor) => actor.id));
  let order = stacking ? (highestDrawnZOrder(scene.actors) ?? -1) + 1 : 0;
  const added = actors.map((actor): SerializedActor => {
    if (
      (actor.parentId && ids.has(actor.parentId)) ||
      actorCameraComponent(actor) ||
      isSceneLayerAnchorActor(actor)
    ) {
      return actor;
    }
    const depth = depthFromZOrder(order);
    if (stacking) order += 1;
    const parent = actor.parentId ? scene.actors.find((entry) => entry.id === actor.parentId) : undefined;
    const z = parent ? localDepth(depth, authoredActorWorldTransform(scene.actors, parent)) : depth;
    const [x, y] = actor.transform.position;
    return { ...actor, transform: { ...actor.transform, position: [x, y, z] } };
  });
  return { ...scene, actors: [...scene.actors, ...added] };
}
