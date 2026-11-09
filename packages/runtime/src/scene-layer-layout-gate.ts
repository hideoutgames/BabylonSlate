import type { OverlaySafeAreaInsets, SerializedActor, Transform, VirtualizedItem } from "@haptic/core";
import { ActorComponent, type Actor } from "@haptic/object-model";
import { actorLayoutName, actorLayoutParentId, actorLayoutVisible, sameActorVirtualItem, sameLayoutProperties } from "./scene-layer-layout-inputs";

type Owner = Actor | ActorComponent;
type TextureSizes = Readonly<Record<string, { width: number; height: number }>>;

const POSE_LENGTH = 10;
/** `===` that also holds for NaN, as `samePlainData` does (and, like it, for 0 and -0). */
const same = (a: unknown, b: unknown): boolean => a === b || (a !== a && b !== b);

/** Whether a transform still holds the ten numbers recorded at `at`; a non-number never does. */
function samePose(transform: Transform, poses: Float64Array, at: number): boolean {
  const { position: p, rotation: r, scale: s } = transform;
  return same(p.x, poses[at]) && same(p.y, poses[at + 1]) && same(p.z, poses[at + 2]) &&
    same(r.x, poses[at + 3]) && same(r.y, poses[at + 4]) && same(r.z, poses[at + 5]) && same(r.w, poses[at + 6]) &&
    same(s.x, poses[at + 7]) && same(s.y, poses[at + 8]) && same(s.z, poses[at + 9]);
}

function writePose(transform: Transform, poses: Float64Array, at: number): void {
  const { position: p, rotation: r, scale: s } = transform;
  poses[at] = p.x; poses[at + 1] = p.y; poses[at + 2] = p.z;
  poses[at + 3] = r.x; poses[at + 4] = r.y; poses[at + 5] = r.z; poses[at + 6] = r.w;
  poses[at + 7] = s.x; poses[at + 8] = s.y; poses[at + 9] = s.z;
}

/** Everything one layer's last layout read, in the order the layout reads it. */
interface Recorded {
  /** The list laid out and each listed actor's role: 0 another layer's, 1 destroyed, 2 owner. */
  actors: Actor[];
  roles: number[];
  actorRevisions: number[];
  /** Per listed actor of the layer: what the layout read from its variables (name, parent and visibility of an owner). */
  actorNames: string[];
  actorParentIds: Array<string | null>;
  actorVisible: boolean[];
  actorItems: Array<VirtualizedItem | undefined>;
  /** The owners derived from that list (an owner actor, then its live components). */
  owners: readonly Owner[];
  /** Per owner: variables revision and, for a component, its parent id and the variables the layout read. */
  revisions: number[];
  parentIds: Array<string | null>;
  properties: Array<Readonly<Record<string, unknown>> | undefined>;
  /** Per owner: position, rotation and scale as the layout left them. */
  poses: Float64Array;
  pixelsPerUnit: number;
  safeArea: unknown[];
  /** Each textured component's guid and the size the layout measured for it. */
  textureGuids: string[];
  textureWidths: unknown[];
  textureHeights: unknown[];
}

/**
 * Recognises a Scene Layer whose layout inputs cannot have changed, without
 * building them. After each layout it records the listed actors, owners,
 * variables revisions, component parent ids, the live transforms the layout left
 * behind, pixels per unit, safe area and the texture sizes it measured.
 * `unchanged` re-reads exactly those and allocates nothing. Variables change only
 * through writes that advance their revision; transforms are plain objects that
 * scripts, physics and anchors mutate in place, hence the compared numbers. An
 * owner whose revision advanced is compared by the variables the layout reads
 * from it, so a write to any other variable (an opacity a Timeline animates, a
 * script's own counter) costs that one owner's reads and leaves the layer
 * unchanged. A layer that cannot be recorded exactly (a non-number in a
 * transform) is never reported unchanged.
 */
export class SceneLayerLayoutGate {
  private readonly layers = new Map<string, Recorded>();

  unchanged(layerId: string, actors: readonly Actor[], owners: readonly Owner[] | undefined, pixelsPerUnit: number,
    texturePixelSizes: TextureSizes, safeAreaInsets: Partial<OverlaySafeAreaInsets>): boolean {
    const recorded = this.layers.get(layerId);
    if (!recorded || owners === undefined || recorded.owners !== owners || recorded.actors.length !== actors.length) return false;
    if (!same(recorded.pixelsPerUnit, pixelsPerUnit)) return false;
    const safe = recorded.safeArea;
    if (!same(safe[0], safeAreaInsets.left) || !same(safe[1], safeAreaInsets.right) || !same(safe[2], safeAreaInsets.top) || !same(safe[3], safeAreaInsets.bottom)) return false;
    for (let index = 0; index < recorded.textureGuids.length; index++) {
      const size = texturePixelSizes[recorded.textureGuids[index]!];
      if (!same(size?.width, recorded.textureWidths[index]) || !same(size?.height, recorded.textureHeights[index])) return false;
    }
    const { poses, revisions, parentIds, properties } = recorded;
    let cursor = 0;
    for (let index = 0; index < actors.length; index++) {
      const actor = actors[index]!;
      if (actor !== recorded.actors[index]) return false;
      const role = actor.sceneLayerId !== layerId ? 0 : actor.destroyed ? 1 : 2;
      if (role !== recorded.roles[index]) return false;
      if (role === 0) continue;
      if (actor.variablesRevision !== recorded.actorRevisions[index]) {
        // Every listed actor of the layer feeds the virtual item map, not only the live ones.
        if (!sameActorVirtualItem(actor, recorded.actorItems[index])) return false;
        if (role === 2 && (actorLayoutName(actor) !== recorded.actorNames[index] || actorLayoutParentId(actor) !== recorded.actorParentIds[index] ||
          actorLayoutVisible(actor) !== recorded.actorVisible[index])) return false;
        recorded.actorRevisions[index] = actor.variablesRevision;
      }
      if (role === 1) continue;
      if (owners[cursor] !== actor || !samePose(actor.transform, poses, cursor * POSE_LENGTH)) return false;
      cursor++;
      for (const component of actor.components) {
        if (component.destroyed) continue;
        if (owners[cursor] !== component || component.parentId !== parentIds[cursor] ||
          !samePose(component.transform, poses, cursor * POSE_LENGTH)) return false;
        if (component.variablesRevision !== revisions[cursor]) {
          const read = properties[cursor];
          if (!read || !sameLayoutProperties(component, read)) return false;
          revisions[cursor] = component.variablesRevision;
        }
        cursor++;
      }
    }
    return cursor === owners.length;
  }

  /**
   * Remember what the layout just read; call once its poses are applied. `source` and `virtualItems` are the inputs
   * built from `actors`: one entry per owner actor, in `owners` order, with its live components.
   */
  record(layerId: string, actors: readonly Actor[], owners: readonly Owner[], pixelsPerUnit: number,
    texturePixelSizes: TextureSizes, safeAreaInsets: Partial<OverlaySafeAreaInsets>,
    source: readonly SerializedActor[], virtualItems: Readonly<Record<string, VirtualizedItem>>): void {
    const previous = this.layers.get(layerId);
    const poses = previous?.poses.length === owners.length * POSE_LENGTH ? previous.poses : new Float64Array(owners.length * POSE_LENGTH);
    const recorded: Recorded = previous ?? {
      actors: [], roles: [], actorRevisions: [], actorNames: [], actorParentIds: [], actorVisible: [], actorItems: [],
      owners, revisions: [], parentIds: [], properties: [], poses,
      pixelsPerUnit, safeArea: [], textureGuids: [], textureWidths: [], textureHeights: [],
    };
    recorded.actors.length = recorded.roles.length = recorded.actorRevisions.length = actors.length;
    recorded.actorNames.length = recorded.actorParentIds.length = recorded.actorVisible.length = recorded.actorItems.length = actors.length;
    recorded.properties.length = owners.length;
    let entries = 0, slot = 0;
    for (let index = 0; index < actors.length; index++) {
      const actor = actors[index]!;
      const role = actor.sceneLayerId !== layerId ? 0 : actor.destroyed ? 1 : 2;
      recorded.actors[index] = actor;
      recorded.roles[index] = role;
      recorded.actorRevisions[index] = actor.variablesRevision;
      recorded.actorItems[index] = role === 0 ? undefined : virtualItems[actor.guid];
      if (role !== 2) continue;
      const entry = source[entries++]!;
      recorded.actorNames[index] = entry.name;
      recorded.actorParentIds[index] = entry.parentId;
      recorded.actorVisible[index] = entry.visible;
      // The actor's own owner slot holds no component variables.
      recorded.properties[slot++] = undefined;
      for (const component of entry.components) recorded.properties[slot++] = component.properties;
    }
    recorded.owners = owners;
    recorded.poses = poses;
    recorded.pixelsPerUnit = pixelsPerUnit;
    recorded.safeArea.length = 0;
    recorded.safeArea.push(safeAreaInsets.left, safeAreaInsets.right, safeAreaInsets.top, safeAreaInsets.bottom);
    recorded.revisions.length = recorded.parentIds.length = owners.length;
    recorded.textureGuids.length = recorded.textureWidths.length = recorded.textureHeights.length = 0;
    let exact = true;
    for (let cursor = 0; cursor < owners.length; cursor++) {
      const owner = owners[cursor]!;
      recorded.revisions[cursor] = owner.variablesRevision;
      writePose(owner.transform, poses, cursor * POSE_LENGTH);
      // A Float64Array coerces; an owner whose transform is not made of numbers cannot be compared exactly.
      if (!samePose(owner.transform, poses, cursor * POSE_LENGTH)) exact = false;
      if (!(owner instanceof ActorComponent)) { recorded.parentIds[cursor] = null; continue; }
      recorded.parentIds[cursor] = owner.parentId;
      const guid = owner.getVariable("textureGuid");
      if (typeof guid !== "string") continue;
      const size = texturePixelSizes[guid];
      recorded.textureGuids.push(guid); recorded.textureWidths.push(size?.width); recorded.textureHeights.push(size?.height);
    }
    if (exact) this.layers.set(layerId, recorded); else this.layers.delete(layerId);
  }

  remove(layerId: string): void { this.layers.delete(layerId); }
  clear(): void { this.layers.clear(); }
}
