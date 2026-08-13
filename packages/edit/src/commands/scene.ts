import type {
  SceneSettings,
  SerializedActor,
  SerializedComponent,
  SerializedScene,
  SerializedTransform,
  ViewportMode,
} from "@babylonslate/core";
import type { EditCommand } from "../command";

function byteSizeOf(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function replaceActor(
  doc: SerializedScene,
  actorId: string,
  update: (actor: SerializedActor) => SerializedActor,
): SerializedScene {
  return {
    ...doc,
    actors: doc.actors.map((actor) =>
      actor.id === actorId ? update(actor) : actor,
    ),
  };
}

export class AddActorCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.addActor";
  readonly actor: SerializedActor;
  readonly index: number;
  readonly byteSize: number;

  constructor(actor: SerializedActor, index = -1) {
    this.actor = actor;
    this.index = index;
    this.byteSize = byteSizeOf(actor);
  }

  apply(doc: SerializedScene): SerializedScene {
    if (doc.actors.some((actor) => actor.id === this.actor.id)) {
      return doc;
    }
    const actors = [...doc.actors];
    if (this.index >= 0 && this.index <= actors.length) {
      actors.splice(this.index, 0, this.actor);
    } else {
      actors.push(this.actor);
    }
    return { ...doc, actors };
  }

  invert(): RemoveActorCommand {
    return new RemoveActorCommand(this.actor, this.index);
  }
}

/**
 * Removing an actor keeps a snapshot of that actor so the inverse can restore
 * it; `byteSize` reports that capture to the stack's byte budget (engineplan §7.3).
 * Callers that delete a hierarchy must emit one RemoveActorCommand per actor
 * (or remove leaves first) so children are not left with dangling parentIds.
 */
export class RemoveActorCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.removeActor";
  readonly actor: SerializedActor;
  readonly index: number;
  readonly byteSize: number;

  constructor(actor: SerializedActor, index = -1) {
    this.actor = actor;
    this.index = index;
    this.byteSize = byteSizeOf(actor);
  }

  apply(doc: SerializedScene): SerializedScene {
    return {
      ...doc,
      actors: doc.actors.filter((actor) => actor.id !== this.actor.id),
    };
  }

  invert(): AddActorCommand {
    return new AddActorCommand(this.actor, this.index);
  }
}

export class SetActorTransformCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.setActorTransform";
  readonly mergeKey: string;
  readonly actorId: string;
  readonly from: SerializedTransform;
  readonly to: SerializedTransform;

  constructor(
    actorId: string,
    from: SerializedTransform,
    to: SerializedTransform,
  ) {
    this.actorId = actorId;
    this.from = from;
    this.to = to;
    this.mergeKey = `transform:${actorId}`;
  }

  apply(doc: SerializedScene): SerializedScene {
    return replaceActor(doc, this.actorId, (actor) => ({
      ...actor,
      transform: {
        position: [...this.to.position],
        rotation: [...this.to.rotation],
        scale: [...this.to.scale],
      },
    }));
  }

  invert(): SetActorTransformCommand {
    return new SetActorTransformCommand(this.actorId, this.to, this.from);
  }
}

export class RenameActorCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.renameActor";
  readonly mergeKey: string;
  readonly actorId: string;
  readonly from: string;
  readonly to: string;

  constructor(actorId: string, from: string, to: string) {
    this.actorId = actorId;
    this.from = from;
    this.to = to;
    this.mergeKey = `rename:${actorId}`;
  }

  apply(doc: SerializedScene): SerializedScene {
    return replaceActor(doc, this.actorId, (actor) => ({
      ...actor,
      name: this.to,
    }));
  }

  invert(): RenameActorCommand {
    return new RenameActorCommand(this.actorId, this.to, this.from);
  }
}

export class ReparentActorCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.reparentActor";
  readonly actorId: string;
  readonly from: string | null;
  readonly to: string | null;

  constructor(actorId: string, from: string | null, to: string | null) {
    this.actorId = actorId;
    this.from = from;
    this.to = to;
  }

  apply(doc: SerializedScene): SerializedScene {
    return replaceActor(doc, this.actorId, (actor) => ({
      ...actor,
      parentId: this.to,
    }));
  }

  invert(): ReparentActorCommand {
    return new ReparentActorCommand(this.actorId, this.to, this.from);
  }
}

export class ReorderActorCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.reorderActor";
  readonly actorId: string;
  readonly from: number;
  readonly to: number;

  constructor(actorId: string, from: number, to: number) {
    this.actorId = actorId;
    this.from = from;
    this.to = to;
  }

  apply(doc: SerializedScene): SerializedScene {
    const index = doc.actors.findIndex((actor) => actor.id === this.actorId);
    if (index === -1) return doc;
    const actors = [...doc.actors];
    const [moved] = actors.splice(index, 1);
    if (!moved) return doc;
    const target = Math.max(0, Math.min(this.to, actors.length));
    actors.splice(target, 0, moved);
    return { ...doc, actors };
  }

  invert(): ReorderActorCommand {
    return new ReorderActorCommand(this.actorId, this.to, this.from);
  }
}

export interface ActorFlags {
  visible: boolean;
  locked: boolean;
}

export class SetActorFlagsCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.setActorFlags";
  readonly actorId: string;
  readonly from: ActorFlags;
  readonly to: ActorFlags;

  constructor(actorId: string, from: ActorFlags, to: ActorFlags) {
    this.actorId = actorId;
    this.from = from;
    this.to = to;
  }

  apply(doc: SerializedScene): SerializedScene {
    return replaceActor(doc, this.actorId, (actor) => ({
      ...actor,
      visible: this.to.visible,
      locked: this.to.locked,
    }));
  }

  invert(): SetActorFlagsCommand {
    return new SetActorFlagsCommand(this.actorId, this.to, this.from);
  }
}

export class AddComponentCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.addComponent";
  readonly actorId: string;
  readonly component: SerializedComponent;
  readonly index: number;
  readonly byteSize: number;

  constructor(
    actorId: string,
    component: SerializedComponent,
    index = -1,
  ) {
    this.actorId = actorId;
    this.component = component;
    this.index = index;
    this.byteSize = byteSizeOf(component);
  }

  apply(doc: SerializedScene): SerializedScene {
    return replaceActor(doc, this.actorId, (actor) => {
      if (actor.components.some((entry) => entry.id === this.component.id)) {
        return actor;
      }
      const components = [...actor.components];
      if (this.index >= 0 && this.index <= components.length) {
        components.splice(this.index, 0, this.component);
      } else {
        components.push(this.component);
      }
      return { ...actor, components };
    });
  }

  invert(): RemoveComponentCommand {
    return new RemoveComponentCommand(this.actorId, this.component, this.index);
  }
}

export class RemoveComponentCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.removeComponent";
  readonly actorId: string;
  readonly component: SerializedComponent;
  readonly index: number;
  readonly byteSize: number;

  constructor(actorId: string, component: SerializedComponent, index = -1) {
    this.actorId = actorId;
    this.component = component;
    this.index = index;
    this.byteSize = byteSizeOf(component);
  }

  apply(doc: SerializedScene): SerializedScene {
    return replaceActor(doc, this.actorId, (actor) => ({
      ...actor,
      components: actor.components.filter(
        (entry) => entry.id !== this.component.id,
      ),
    }));
  }

  invert(): AddComponentCommand {
    return new AddComponentCommand(this.actorId, this.component, this.index);
  }
}

export class ReorderComponentCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.reorderComponent";
  readonly actorId: string;
  readonly componentId: string;
  readonly from: number;
  readonly to: number;

  constructor(
    actorId: string,
    componentId: string,
    from: number,
    to: number,
  ) {
    this.actorId = actorId;
    this.componentId = componentId;
    this.from = from;
    this.to = to;
  }

  apply(doc: SerializedScene): SerializedScene {
    return replaceActor(doc, this.actorId, (actor) => {
      const index = actor.components.findIndex(
        (entry) => entry.id === this.componentId,
      );
      if (index === -1) return actor;
      const components = [...actor.components];
      const [moved] = components.splice(index, 1);
      if (!moved) return actor;
      const target = Math.max(0, Math.min(this.to, components.length));
      components.splice(target, 0, moved);
      return { ...actor, components };
    });
  }

  invert(): ReorderComponentCommand {
    return new ReorderComponentCommand(
      this.actorId,
      this.componentId,
      this.to,
      this.from,
    );
  }
}

export class ReparentComponentCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.reparentComponent";
  readonly actorId: string;
  readonly componentId: string;
  readonly from: string | null;
  readonly to: string | null;

  constructor(
    actorId: string,
    componentId: string,
    from: string | null,
    to: string | null,
  ) {
    this.actorId = actorId;
    this.componentId = componentId;
    this.from = from;
    this.to = to;
  }

  apply(doc: SerializedScene): SerializedScene {
    return replaceActor(doc, this.actorId, (actor) => ({
      ...actor,
      components: actor.components.map((component) =>
        component.id === this.componentId
          ? { ...component, parentId: this.to }
          : component,
      ),
    }));
  }

  invert(): ReparentComponentCommand {
    return new ReparentComponentCommand(
      this.actorId,
      this.componentId,
      this.to,
      this.from,
    );
  }
}

export class SetComponentPropertyCommand
  implements EditCommand<SerializedScene>
{
  readonly type = "scene.setComponentProperty";
  readonly mergeKey: string;
  readonly actorId: string;
  readonly componentId: string;
  readonly property: string;
  readonly from: unknown;
  readonly to: unknown;

  constructor(
    actorId: string,
    componentId: string,
    property: string,
    from: unknown,
    to: unknown,
  ) {
    this.actorId = actorId;
    this.componentId = componentId;
    this.property = property;
    this.from = from;
    this.to = to;
    this.mergeKey = `prop:${actorId}:${componentId}:${property}`;
  }

  apply(doc: SerializedScene): SerializedScene {
    return replaceActor(doc, this.actorId, (actor) => ({
      ...actor,
      components: actor.components.map((component) =>
        component.id === this.componentId
          ? {
              ...component,
              properties: { ...component.properties, [this.property]: this.to },
            }
          : component,
      ),
    }));
  }

  invert(): SetComponentPropertyCommand {
    return new SetComponentPropertyCommand(
      this.actorId,
      this.componentId,
      this.property,
      this.to,
      this.from,
    );
  }
}

export class SetSceneSettingCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.setSceneSetting";
  readonly mergeKey: string;
  readonly key: keyof SceneSettings;
  readonly from: SceneSettings[keyof SceneSettings];
  readonly to: SceneSettings[keyof SceneSettings];

  constructor(
    key: keyof SceneSettings,
    from: SceneSettings[keyof SceneSettings],
    to: SceneSettings[keyof SceneSettings],
  ) {
    this.key = key;
    this.from = from;
    this.to = to;
    this.mergeKey = `sceneSetting:${String(key)}`;
  }

  apply(doc: SerializedScene): SerializedScene {
    return {
      ...doc,
      settings: { ...doc.settings, [this.key]: this.to } as SceneSettings,
    };
  }

  invert(): SetSceneSettingCommand {
    return new SetSceneSettingCommand(this.key, this.to, this.from);
  }
}

export class SetViewportModeCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.setViewportMode";
  readonly from: ViewportMode;
  readonly to: ViewportMode;

  constructor(from: ViewportMode, to: ViewportMode) {
    this.from = from;
    this.to = to;
  }

  apply(doc: SerializedScene): SerializedScene {
    return { ...doc, viewportMode: this.to };
  }

  invert(): SetViewportModeCommand {
    return new SetViewportModeCommand(this.to, this.from);
  }
}

export class SetSceneNameCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.setSceneName";
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    this.from = from;
    this.to = to;
  }

  apply(doc: SerializedScene): SerializedScene {
    return { ...doc, name: this.to };
  }

  invert(): SetSceneNameCommand {
    return new SetSceneNameCommand(this.to, this.from);
  }
}

export type SceneEditCommand =
  | AddActorCommand
  | RemoveActorCommand
  | SetActorTransformCommand
  | RenameActorCommand
  | ReparentActorCommand
  | ReorderActorCommand
  | SetActorFlagsCommand
  | AddComponentCommand
  | RemoveComponentCommand
  | ReorderComponentCommand
  | ReparentComponentCommand
  | SetComponentPropertyCommand
  | SetSceneSettingCommand
  | SetViewportModeCommand
  | SetSceneNameCommand;

export const SCENE_COMMAND_TYPES = [
  "scene.addActor",
  "scene.removeActor",
  "scene.setActorTransform",
  "scene.renameActor",
  "scene.reparentActor",
  "scene.reorderActor",
  "scene.setActorFlags",
  "scene.addComponent",
  "scene.removeComponent",
  "scene.reorderComponent",
  "scene.reparentComponent",
  "scene.setComponentProperty",
  "scene.setSceneSetting",
  "scene.setViewportMode",
  "scene.setSceneName",
] as const;

export function createAddActorCommandFromJson(
  payload: Record<string, unknown>,
): AddActorCommand {
  return new AddActorCommand(
    payload.actor as SerializedActor,
    Number(payload.index ?? -1),
  );
}

export function createRemoveActorCommandFromJson(
  payload: Record<string, unknown>,
): RemoveActorCommand {
  return new RemoveActorCommand(
    payload.actor as SerializedActor,
    Number(payload.index ?? -1),
  );
}

export function createSetActorTransformCommandFromJson(
  payload: Record<string, unknown>,
): SetActorTransformCommand {
  return new SetActorTransformCommand(
    String(payload.actorId),
    payload.from as SerializedTransform,
    payload.to as SerializedTransform,
  );
}

export function createRenameActorCommandFromJson(
  payload: Record<string, unknown>,
): RenameActorCommand {
  return new RenameActorCommand(
    String(payload.actorId),
    String(payload.from),
    String(payload.to),
  );
}

export function createReparentActorCommandFromJson(
  payload: Record<string, unknown>,
): ReparentActorCommand {
  return new ReparentActorCommand(
    String(payload.actorId),
    (payload.from as string | null) ?? null,
    (payload.to as string | null) ?? null,
  );
}

export function createReorderActorCommandFromJson(
  payload: Record<string, unknown>,
): ReorderActorCommand {
  return new ReorderActorCommand(
    String(payload.actorId),
    Number(payload.from),
    Number(payload.to),
  );
}

export function createSetActorFlagsCommandFromJson(
  payload: Record<string, unknown>,
): SetActorFlagsCommand {
  return new SetActorFlagsCommand(
    String(payload.actorId),
    payload.from as ActorFlags,
    payload.to as ActorFlags,
  );
}

export function createAddComponentCommandFromJson(
  payload: Record<string, unknown>,
): AddComponentCommand {
  return new AddComponentCommand(
    String(payload.actorId),
    payload.component as SerializedComponent,
    Number(payload.index ?? -1),
  );
}

export function createRemoveComponentCommandFromJson(
  payload: Record<string, unknown>,
): RemoveComponentCommand {
  return new RemoveComponentCommand(
    String(payload.actorId),
    payload.component as SerializedComponent,
    Number(payload.index ?? -1),
  );
}

export function createReorderComponentCommandFromJson(
  payload: Record<string, unknown>,
): ReorderComponentCommand {
  return new ReorderComponentCommand(
    String(payload.actorId),
    String(payload.componentId),
    Number(payload.from),
    Number(payload.to),
  );
}

export function createReparentComponentCommandFromJson(
  payload: Record<string, unknown>,
): ReparentComponentCommand {
  return new ReparentComponentCommand(
    String(payload.actorId),
    String(payload.componentId),
    (payload.from as string | null) ?? null,
    (payload.to as string | null) ?? null,
  );
}

export function createSetComponentPropertyCommandFromJson(
  payload: Record<string, unknown>,
): SetComponentPropertyCommand {
  return new SetComponentPropertyCommand(
    String(payload.actorId),
    String(payload.componentId),
    String(payload.property),
    payload.from,
    payload.to,
  );
}

export function createSetSceneSettingCommandFromJson(
  payload: Record<string, unknown>,
): SetSceneSettingCommand {
  return new SetSceneSettingCommand(
    payload.key as keyof SceneSettings,
    payload.from as SceneSettings[keyof SceneSettings],
    payload.to as SceneSettings[keyof SceneSettings],
  );
}

export function createSetViewportModeCommandFromJson(
  payload: Record<string, unknown>,
): SetViewportModeCommand {
  return new SetViewportModeCommand(
    payload.from as ViewportMode,
    payload.to as ViewportMode,
  );
}

export function createSetSceneNameCommandFromJson(
  payload: Record<string, unknown>,
): SetSceneNameCommand {
  return new SetSceneNameCommand(String(payload.from), String(payload.to));
}
