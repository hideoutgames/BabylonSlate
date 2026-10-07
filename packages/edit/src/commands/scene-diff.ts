import type {
  SceneSettings,
  SerializedActor,
  SerializedScene,
  SerializedTransform,
} from "@babylonslate/core";
import { isSceneLayerAnchorActor } from "@babylonslate/core";
import {
  AddActorCommand,
  AddComponentCommand,
  AddFolderCommand,
  RemoveFolderCommand,
  RenameFolderCommand,
  ReparentFolderCommand,
  SetActorFolderCommand,
  RemoveActorCommand,
  RemoveComponentCommand,
  RenameActorCommand,
  ReorderActorCommand,
  ReorderComponentCommand,
  ReparentActorCommand,
  ReparentComponentCommand,
  SetActorFlagsCommand,
  SetActorTransformCommand,
  SetActorsTransformsCommand,
  SetComponentPropertyCommand,
  SetComponentLinkageCommand,
  SetComponentTransformCommand,
  SetSceneNameCommand,
  SetSceneSettingCommand,
  SetViewportModeCommand,
  type SceneEditCommand,
} from "./scene";
import { SetActorSuppressedComponentsCommand, SetComponentMaterialInstanceCommand } from "./scene-instance";
import {
  ReorderFolderCommand,
  SetActorClassCommand,
  SetActorPropertiesCommand,
  SetComponentClassCommand,
  SetComponentTransformPresenceCommand,
  SetSceneOverlayEditorCommand,
} from "./scene-fields";
import { ReplaceSceneCommand } from "./replace-scene";

function transformEqual(a: SerializedTransform, b: SerializedTransform): boolean {
  return (
    a.position.every((value, index) => value === b.position[index]) &&
    a.rotation.every((value, index) => value === b.rotation[index]) &&
    a.scale.every((value, index) => value === b.scale[index])
  );
}

function propertiesDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(
    (key) =>
      before[key] !== after[key] &&
      JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

interface ListPlan<T> {
  /** Highest index first, so a reversed (Undo) batch re-inserts lowest first. */
  removed: Array<{ item: T; index: number }>;
  /** Sequential moves over the surviving rows; each `from` is the live index. */
  moves: Array<{ id: string; from: number; to: number }>;
  /** Lowest index first, so each insert lands at its final index. */
  added: Array<{ item: T; index: number }>;
}

/**
 * Turns one ordered id list into another: remove, then reorder the survivors,
 * then insert. Replaying the steps in order reproduces `after` exactly, and the
 * reversed inverses reproduce `before`.
 */
function planList<T extends { id: string }>(before: readonly T[], after: readonly T[]): ListPlan<T> {
  const afterIds = new Set(after.map((item) => item.id));
  const beforeIds = new Set(before.map((item) => item.id));
  const removed = before
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !afterIds.has(item.id))
    .reverse();
  const added = after
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !beforeIds.has(item.id));
  const working = before.filter((item) => afterIds.has(item.id)).map((item) => item.id);
  const desired = after.filter((item) => beforeIds.has(item.id)).map((item) => item.id);
  const moves: ListPlan<T>["moves"] = [];
  for (let to = 0; to < desired.length; to++) {
    const id = desired[to]!;
    const from = working.indexOf(id);
    if (from === to || from === -1) continue;
    moves.push({ id, from, to });
    working.splice(from, 1);
    working.splice(to, 0, id);
  }
  return { removed, moves, added };
}

function diffComponents(
  actorId: string,
  before: SerializedActor,
  after: SerializedActor,
  commands: SceneEditCommand[],
): void {
  const beforeComponents = new Map(
    before.components.map((component) => [component.id, component]),
  );

  for (const component of after.components) {
    const id = component.id;
    const previous = beforeComponents.get(id);
    if (!previous || previous === component) continue;
    // Class first: the transform deltas below honour the 2D anchor guard of
    // the component's final class.
    if (previous.classId !== component.classId) {
      commands.push(new SetComponentClassCommand(actorId, id, previous.classId, component.classId));
    }
    const linkage = {
      from: { sourceId: previous.sourceId, overrideKeys: previous.overrideKeys },
      to: { sourceId: component.sourceId, overrideKeys: component.overrideKeys },
    };
    const changedLinkage = JSON.stringify(linkage.from) !== JSON.stringify(linkage.to);
    // Carry unchanged linkage too: a coalesced scrub's final command must
    // restore the override when Redo follows the first command's inverse.
    const editLinkage = previous.sourceId || component.sourceId || changedLinkage ? linkage : undefined;
    let recordedLinkage = false;
    if (JSON.stringify(previous.materialInstance) !== JSON.stringify(component.materialInstance)) {
      commands.push(new SetComponentMaterialInstanceCommand(actorId, id, previous.materialInstance, component.materialInstance));
    }
    for (const key of propertiesDiff(previous.properties, component.properties)) {
      commands.push(
        new SetComponentPropertyCommand(
          actorId,
          id,
          key,
          previous.properties[key],
          component.properties[key],
          editLinkage,
        ),
      );
      recordedLinkage = true;
    }
    if ((previous.parentId ?? null) !== (component.parentId ?? null)) {
      commands.push(
        new ReparentComponentCommand(
          actorId,
          id,
          previous.parentId ?? null,
          component.parentId ?? null,
        ),
      );
    }
    const previousTransform = previous.transform;
    const nextTransform = component.transform;
    if (previousTransform && nextTransform) {
      if (!transformEqual(previousTransform, nextTransform)) {
        commands.push(
          new SetComponentTransformCommand(
            actorId,
            id,
            previousTransform,
            nextTransform,
            editLinkage,
          ),
        );
        recordedLinkage = true;
      }
    } else if (previousTransform || nextTransform) {
      commands.push(new SetComponentTransformPresenceCommand(actorId, id, previousTransform, nextTransform));
    }
    if (changedLinkage && !recordedLinkage) {
      commands.push(new SetComponentLinkageCommand(actorId, id, linkage.from, linkage.to));
    }
  }

  const plan = planList(before.components, after.components);
  for (const { item, index } of plan.removed) {
    commands.push(new RemoveComponentCommand(actorId, item, index));
  }
  for (const { id, from, to } of plan.moves) {
    commands.push(new ReorderComponentCommand(actorId, id, from, to));
  }
  for (const { item, index } of plan.added) {
    commands.push(new AddComponentCommand(actorId, item, index));
  }
}

function diffFolders(
  before: SerializedScene,
  after: SerializedScene,
  commands: SceneEditCommand[],
): void {
  const beforeFolders = new Map(
    before.folders.map((folder) => [folder.id, folder]),
  );

  for (const folder of after.folders) {
    const previous = beforeFolders.get(folder.id);
    if (!previous) continue;
    if (previous.name !== folder.name) {
      commands.push(new RenameFolderCommand(folder.id, previous.name, folder.name));
    }
    if (previous.parentFolderId !== folder.parentFolderId) {
      commands.push(
        new ReparentFolderCommand(
          folder.id,
          previous.parentFolderId,
          folder.parentFolderId,
        ),
      );
    }
  }

  const plan = planList(before.folders, after.folders);
  for (const { item, index } of plan.removed) {
    commands.push(new RemoveFolderCommand(item, index));
  }
  for (const { id, from, to } of plan.moves) {
    commands.push(new ReorderFolderCommand(id, from, to));
  }
  for (const { item, index } of plan.added) {
    commands.push(new AddFolderCommand(item, index));
  }
}

function diffActor(previous: SerializedActor, actor: SerializedActor, commands: SceneEditCommand[]): void {
  const id = actor.id;
  if (previous.classId !== actor.classId) {
    commands.push(new SetActorClassCommand(id, previous.classId, actor.classId));
  }
  if (JSON.stringify(previous.suppressedComponentSourceIds) !== JSON.stringify(actor.suppressedComponentSourceIds)) {
    commands.push(new SetActorSuppressedComponentsCommand(id, previous.suppressedComponentSourceIds, actor.suppressedComponentSourceIds));
  }
  if (previous.name !== actor.name) {
    commands.push(new RenameActorCommand(id, previous.name, actor.name));
  }
  if (previous.parentId !== actor.parentId) {
    commands.push(
      new ReparentActorCommand(id, previous.parentId, actor.parentId),
    );
  }
  if ((previous.folderId ?? null) !== (actor.folderId ?? null)) {
    commands.push(
      new SetActorFolderCommand(
        id,
        previous.folderId ?? null,
        actor.folderId ?? null,
      ),
    );
  }
  if (
    previous.visible !== actor.visible ||
    previous.locked !== actor.locked
  ) {
    commands.push(
      new SetActorFlagsCommand(
        id,
        { visible: previous.visible, locked: previous.locked },
        { visible: actor.visible, locked: actor.locked },
      ),
    );
  }
  if (JSON.stringify(previous.properties) !== JSON.stringify(actor.properties)) {
    commands.push(new SetActorPropertiesCommand(id, previous.properties, actor.properties));
  }
  diffComponents(id, previous, actor, commands);
  // After the components: the 2D anchor guard sees the actor's final components.
  if (!transformEqual(previous.transform, actor.transform)) {
    commands.push(
      new SetActorTransformCommand(id, previous.transform, actor.transform),
    );
  }
}

/**
 * Derives minimal scene edit commands from a before/after pair, mirroring
 * `diffGraphCommands` so every editing surface can route through the undo stack.
 * Replaying the commands on `before` reproduces `after` field for field, except
 * where a command guard refuses the change (2D anchor poses).
 */
export function diffSceneCommands(
  before: SerializedScene,
  after: SerializedScene,
): SceneEditCommand[] {
  const commands: SceneEditCommand[] = [];

  if (before.name !== after.name) {
    commands.push(new SetSceneNameCommand(before.name, after.name));
  }

  if (before.viewportMode !== after.viewportMode) {
    commands.push(
      new SetViewportModeCommand(before.viewportMode, after.viewportMode),
    );
  }

  if (before.overlayEditor !== after.overlayEditor) {
    commands.push(new SetSceneOverlayEditorCommand(before.overlayEditor, after.overlayEditor));
  }

  const settingKeys = new Set([
    ...Object.keys(before.settings),
    ...Object.keys(after.settings),
  ] as Array<keyof SceneSettings>);
  for (const key of settingKeys) {
    if (
      JSON.stringify(before.settings[key]) !==
      JSON.stringify(after.settings[key])
    ) {
      commands.push(
        new SetSceneSettingCommand(
          key,
          before.settings[key],
          after.settings[key],
        ),
      );
    }
  }

  diffFolders(before, after, commands);

  const beforeActors = new Map(before.actors.map((actor) => [actor.id, actor]));
  for (const actor of after.actors) {
    const previous = beforeActors.get(actor.id);
    if (previous && previous !== actor) diffActor(previous, actor, commands);
  }

  const plan = planList(before.actors, after.actors);
  for (const { item, index } of plan.removed) {
    commands.push(new RemoveActorCommand(item, index));
  }
  for (const { id, from, to } of plan.moves) {
    commands.push(new ReorderActorCommand(id, from, to));
  }
  for (const { item, index } of plan.added) {
    commands.push(new AddActorCommand(item, index));
  }

  return batchActorTransformCommands(commands);
}

/** One undo step when a gizmo drag (or similar) moves several actors. */
function batchActorTransformCommands(
  commands: SceneEditCommand[],
): SceneEditCommand[] {
  const transforms = commands.filter(
    (command): command is SetActorTransformCommand =>
      command instanceof SetActorTransformCommand,
  );
  if (transforms.length < 2) return commands;
  const batched = new SetActorsTransformsCommand(
    transforms.map((command) => ({
      actorId: command.actorId,
      from: command.from,
      to: command.to,
    })),
  );
  // At the last transform's slot, so every moved actor's component deltas
  // (which decide the 2D anchor guard) have already applied.
  const last = commands.lastIndexOf(transforms.at(-1)!);
  return commands.flatMap((command, index) =>
    index === last ? [batched] : command instanceof SetActorTransformCommand ? [] : [command],
  );
}

/** JSON value semantics: absent and `undefined` keys match, key order is ignored. */
function jsonEquivalent(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  const leftObject = typeof left === "object" && left !== null;
  const rightObject = typeof right === "object" && right !== null;
  if (!leftObject || !rightObject) {
    return !leftObject && !rightObject && JSON.stringify(left) === JSON.stringify(right);
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((value, index) => jsonEquivalent(value ?? null, right[index] ?? null));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter((key) => isJsonValue(a[key]));
  return keys.length === Object.keys(b).filter((key) => isJsonValue(b[key])).length &&
    keys.every((key) => isJsonValue(b[key]) && jsonEquivalent(a[key], b[key]));
}

/** JSON.stringify omits these object members. */
function isJsonValue(value: unknown): boolean {
  return value !== undefined && typeof value !== "function" && typeof value !== "symbol";
}

/**
 * `after` with the poses the 2D anchor guard keeps taken from `applied`: an
 * Outliner anchor actor's transform and a 2D anchor component's transform.
 */
function withGuardedAnchorPoses(after: SerializedScene, applied: SerializedScene): SerializedScene {
  const appliedActors = new Map(applied.actors.map((actor) => [actor.id, actor]));
  let changed = false;
  const actors = after.actors.map((actor) => {
    const current = appliedActors.get(actor.id);
    if (!current) return actor;
    let next = actor;
    if (isSceneLayerAnchorActor(actor) && !jsonEquivalent(actor.transform, current.transform)) {
      next = { ...next, transform: current.transform };
    }
    const components = actor.components.map((component) => {
      if (component.classId !== "2DAnchorComponent") return component;
      const kept = current.components.find((entry) => entry.id === component.id);
      if (!kept || jsonEquivalent(component.transform, kept.transform)) return component;
      const guarded = { ...component };
      if (kept.transform === undefined) delete guarded.transform;
      else guarded.transform = kept.transform;
      return guarded;
    });
    if (components.some((component, index) => component !== actor.components[index])) {
      next = { ...next, components };
    }
    if (next !== actor) changed = true;
    return next;
  });
  return changed ? { ...after, actors } : after;
}

/** Canonical JSON copy, as a scene is saved and journalled. */
function jsonCopy(scene: SerializedScene): SerializedScene {
  return JSON.parse(JSON.stringify(scene)) as SerializedScene;
}

/**
 * Commands for one accepted scene edit; empty when nothing would change.
 * Prefers `diffSceneCommands`. When the deltas do not reproduce `after` (a
 * field no delta represents), the whole change becomes one
 * `ReplaceSceneCommand`, so no accepted edit bypasses Undo or the journal.
 */
export function planSceneChange(
  before: SerializedScene,
  after: SerializedScene,
): SceneEditCommand[] {
  const commands = diffSceneCommands(before, after);
  const applied = commands.reduce<SerializedScene>((doc, command) => command.apply(doc), before);
  const target = withGuardedAnchorPoses(after, applied);
  if (jsonEquivalent(applied, target)) {
    // Deltas a guard refused (or that rewrote equal values) are not an edit.
    return commands.length > 0 && jsonEquivalent(applied, before) ? [] : commands;
  }
  return [new ReplaceSceneCommand(jsonCopy(before), jsonCopy(target))];
}
