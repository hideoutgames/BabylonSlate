import type {
  SceneSettings,
  SerializedActor,
  SerializedScene,
  SerializedTransform,
} from "@babylonslate/core";
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

function diffComponents(
  actorId: string,
  before: SerializedActor,
  after: SerializedActor,
  commands: SceneEditCommand[],
): void {
  const beforeComponents = new Map(
    before.components.map((component) => [component.id, component]),
  );
  const afterComponents = new Map(
    after.components.map((component) => [component.id, component]),
  );

  for (const [id, component] of afterComponents) {
    const previous = beforeComponents.get(id);
    if (!previous) {
      commands.push(
        new AddComponentCommand(
          actorId,
          component,
          after.components.findIndex((entry) => entry.id === id),
        ),
      );
      continue;
    }
    if (previous === component) continue;
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
    if (
      previousTransform &&
      nextTransform &&
      !transformEqual(previousTransform, nextTransform)
    ) {
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
    if (changedLinkage && !recordedLinkage) {
      commands.push(new SetComponentLinkageCommand(actorId, id, linkage.from, linkage.to));
    }
  }

  for (const [id, component] of beforeComponents) {
    if (!afterComponents.has(id)) {
      commands.push(
        new RemoveComponentCommand(
          actorId,
          component,
          before.components.findIndex((entry) => entry.id === id),
        ),
      );
    }
  }

  // Detect pure reorders among components that exist in both versions.
  if (
    before.components.length === after.components.length &&
    before.components.every((component) => afterComponents.has(component.id))
  ) {
    const beforeOrder = before.components.map((component) => component.id);
    const afterOrder = after.components.map((component) => component.id);
    if (beforeOrder.some((id, index) => id !== afterOrder[index])) {
      // Emit one reorder per moved id so replaying reconstructs `after`
      // without depending on intermediate map iteration order.
      for (let to = 0; to < afterOrder.length; to++) {
        const id = afterOrder[to]!;
        const from = beforeOrder.indexOf(id);
        if (from !== to) {
          commands.push(new ReorderComponentCommand(actorId, id, from, to));
          // Simulate the move on beforeOrder so subsequent deltas are relative
          // to the partially-applied order (matches command.apply semantics).
          const [moved] = beforeOrder.splice(from, 1);
          beforeOrder.splice(to, 0, moved!);
        }
      }
    }
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
  const afterFolders = new Map(after.folders.map((folder) => [folder.id, folder]));
  const beforeIndexById = new Map(
    before.folders.map((folder, index) => [folder.id, index]),
  );
  const afterIndexById = new Map(
    after.folders.map((folder, index) => [folder.id, index]),
  );

  for (const [id, folder] of afterFolders) {
    const previous = beforeFolders.get(id);
    if (!previous) {
      commands.push(
        new AddFolderCommand(
          folder,
          afterIndexById.get(id) ?? -1,
        ),
      );
      continue;
    }
    if (previous.name !== folder.name) {
      commands.push(new RenameFolderCommand(id, previous.name, folder.name));
    }
    if (previous.parentFolderId !== folder.parentFolderId) {
      commands.push(
        new ReparentFolderCommand(
          id,
          previous.parentFolderId,
          folder.parentFolderId,
        ),
      );
    }
  }

  // Undo restores the original indices, so remove from the end first.
  for (const [id, folder] of [...beforeFolders].reverse()) {
    if (!afterFolders.has(id)) {
      commands.push(
        new RemoveFolderCommand(
          folder,
          beforeIndexById.get(id) ?? -1,
        ),
      );
    }
  }
}

/**
 * Derives minimal scene edit commands from a before/after pair, mirroring
 * `diffGraphCommands` so every editing surface can route through the undo stack.
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
  const afterActors = new Map(after.actors.map((actor) => [actor.id, actor]));
  const beforeIndexById = new Map(
    before.actors.map((actor, index) => [actor.id, index]),
  );
  const afterIndexById = new Map(
    after.actors.map((actor, index) => [actor.id, index]),
  );

  for (const [id, actor] of afterActors) {
    const previous = beforeActors.get(id);
    if (!previous) {
      commands.push(
        new AddActorCommand(actor, afterIndexById.get(id) ?? -1),
      );
      continue;
    }
    if (previous !== actor) {
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
      if (!transformEqual(previous.transform, actor.transform)) {
        commands.push(
          new SetActorTransformCommand(id, previous.transform, actor.transform),
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
    }
    const beforeIndex = beforeIndexById.get(id) ?? -1;
    const afterIndex = afterIndexById.get(id) ?? -1;
    if (
      beforeIndex !== afterIndex &&
      before.actors.length === after.actors.length
    ) {
      commands.push(new ReorderActorCommand(id, beforeIndex, afterIndex));
    }
    if (previous !== actor) diffComponents(id, previous, actor, commands);
  }

  for (const [id, actor] of [...beforeActors].reverse()) {
    if (!afterActors.has(id)) {
      commands.push(
        new RemoveActorCommand(
          actor,
          beforeIndexById.get(id) ?? -1,
        ),
      );
    }
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
  const result: SceneEditCommand[] = [];
  let inserted = false;
  for (const command of commands) {
    if (!(command instanceof SetActorTransformCommand)) {
      result.push(command);
      continue;
    }
    if (!inserted) {
      result.push(batched);
      inserted = true;
    }
  }
  return result;
}
