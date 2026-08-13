import type {
  SceneSettings,
  SerializedActor,
  SerializedScene,
  SerializedTransform,
} from "@babylonslate/core";
import {
  AddActorCommand,
  AddComponentCommand,
  RemoveActorCommand,
  RemoveComponentCommand,
  RenameActorCommand,
  ReorderActorCommand,
  ReorderComponentCommand,
  ReparentActorCommand,
  ReparentComponentCommand,
  SetActorFlagsCommand,
  SetActorTransformCommand,
  SetComponentPropertyCommand,
  SetSceneNameCommand,
  SetSceneSettingCommand,
  SetViewportModeCommand,
  type SceneEditCommand,
} from "./scene";

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
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
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
    for (const key of propertiesDiff(previous.properties, component.properties)) {
      commands.push(
        new SetComponentPropertyCommand(
          actorId,
          id,
          key,
          previous.properties[key],
          component.properties[key],
        ),
      );
    }
    if (previous.parentId !== component.parentId) {
      commands.push(
        new ReparentComponentCommand(
          actorId,
          id,
          previous.parentId,
          component.parentId,
        ),
      );
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

  for (const key of Object.keys(after.settings) as Array<keyof SceneSettings>) {
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

  const beforeActors = new Map(before.actors.map((actor) => [actor.id, actor]));
  const afterActors = new Map(after.actors.map((actor) => [actor.id, actor]));

  for (const [id, actor] of afterActors) {
    const previous = beforeActors.get(id);
    if (!previous) {
      commands.push(
        new AddActorCommand(
          actor,
          after.actors.findIndex((entry) => entry.id === id),
        ),
      );
      continue;
    }
    if (previous.name !== actor.name) {
      commands.push(new RenameActorCommand(id, previous.name, actor.name));
    }
    if (previous.parentId !== actor.parentId) {
      commands.push(
        new ReparentActorCommand(id, previous.parentId, actor.parentId),
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
    const beforeIndex = before.actors.findIndex((entry) => entry.id === id);
    const afterIndex = after.actors.findIndex((entry) => entry.id === id);
    if (
      beforeIndex !== afterIndex &&
      before.actors.length === after.actors.length
    ) {
      commands.push(new ReorderActorCommand(id, beforeIndex, afterIndex));
    }
    diffComponents(id, previous, actor, commands);
  }

  for (const [id, actor] of beforeActors) {
    if (!afterActors.has(id)) {
      commands.push(
        new RemoveActorCommand(
          actor,
          before.actors.findIndex((entry) => entry.id === id),
        ),
      );
    }
  }

  return commands;
}
