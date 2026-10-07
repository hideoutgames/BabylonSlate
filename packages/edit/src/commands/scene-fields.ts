import type { SerializedActor, SerializedComponent, SerializedScene, SerializedTransform } from "@babylonslate/core";
import type { EditCommand } from "../command";
import { snapshotBytes } from "../snapshot-bytes";

// Deltas for scene fields the original command set did not cover, so
// `diffSceneCommands` can represent every authored field.

function updateActor(
  doc: SerializedScene,
  actorId: string,
  update: (actor: SerializedActor) => SerializedActor,
): SerializedScene {
  return { ...doc, actors: doc.actors.map((actor) => actor.id === actorId ? update(actor) : actor) };
}

function updateComponent(
  doc: SerializedScene,
  actorId: string,
  componentId: string,
  update: (component: SerializedComponent) => SerializedComponent,
): SerializedScene {
  return updateActor(doc, actorId, (actor) => ({
    ...actor,
    components: actor.components.map((component) => component.id === componentId ? update(component) : component),
  }));
}

/** Per-instance actor variable overrides, including SceneLayer switcher entries. */
export class SetActorPropertiesCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.setActorProperties";
  readonly mergeKey: string;
  readonly byteSize: number;
  readonly actorId: string;
  readonly from: Record<string, unknown> | undefined;
  readonly to: Record<string, unknown> | undefined;

  constructor(actorId: string, from: Record<string, unknown> | undefined, to: Record<string, unknown> | undefined) {
    this.actorId = actorId;
    this.from = from;
    this.to = to;
    this.mergeKey = `actorProperties:${actorId}`;
    this.byteSize = snapshotBytes({ from, to });
  }

  apply(doc: SerializedScene): SerializedScene {
    return updateActor(doc, this.actorId, (actor) => {
      const next = { ...actor };
      if (this.to === undefined) delete next.properties;
      else next.properties = structuredClone(this.to);
      return next;
    });
  }

  invert(): SetActorPropertiesCommand {
    return new SetActorPropertiesCommand(this.actorId, this.to, this.from);
  }
}

/** Retargets an actor instance to another Class while keeping its id. */
export class SetActorClassCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.setActorClass";
  readonly byteSize: number;
  readonly actorId: string;
  readonly from: string;
  readonly to: string;

  constructor(actorId: string, from: string, to: string) {
    this.actorId = actorId;
    this.from = from;
    this.to = to;
    this.byteSize = snapshotBytes({ from, to });
  }

  apply(doc: SerializedScene): SerializedScene {
    return updateActor(doc, this.actorId, (actor) => ({ ...actor, classId: this.to }));
  }

  invert(): SetActorClassCommand {
    return new SetActorClassCommand(this.actorId, this.to, this.from);
  }
}

/** Changes a component's class in place, as prefab sync does for a retyped Class row. */
export class SetComponentClassCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.setComponentClass";
  readonly byteSize: number;
  readonly actorId: string;
  readonly componentId: string;
  readonly from: string;
  readonly to: string;

  constructor(actorId: string, componentId: string, from: string, to: string) {
    this.actorId = actorId;
    this.componentId = componentId;
    this.from = from;
    this.to = to;
    this.byteSize = snapshotBytes({ from, to });
  }

  apply(doc: SerializedScene): SerializedScene {
    return updateComponent(doc, this.actorId, this.componentId, (component) => ({ ...component, classId: this.to }));
  }

  invert(): SetComponentClassCommand {
    return new SetComponentClassCommand(this.actorId, this.componentId, this.to, this.from);
  }
}

/**
 * Adds or removes a component's local transform. `SetComponentTransformCommand`
 * edits one that exists on both sides. A 2D anchor never gains a transform.
 */
export class SetComponentTransformPresenceCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.setComponentTransformPresence";
  readonly byteSize: number;
  readonly actorId: string;
  readonly componentId: string;
  readonly from: SerializedTransform | undefined;
  readonly to: SerializedTransform | undefined;

  constructor(
    actorId: string,
    componentId: string,
    from: SerializedTransform | undefined,
    to: SerializedTransform | undefined,
  ) {
    this.actorId = actorId;
    this.componentId = componentId;
    this.from = from;
    this.to = to;
    this.byteSize = snapshotBytes({ from, to });
  }

  apply(doc: SerializedScene): SerializedScene {
    return updateComponent(doc, this.actorId, this.componentId, (component) => {
      if (this.to !== undefined && component.classId === "2DAnchorComponent") return component;
      const next = { ...component };
      if (this.to === undefined) delete next.transform;
      else next.transform = structuredClone(this.to);
      return next;
    });
  }

  invert(): SetComponentTransformPresenceCommand {
    return new SetComponentTransformPresenceCommand(this.actorId, this.componentId, this.to, this.from);
  }
}

/** Outliner folder order; `to` is the index after the folder leaves `from`. */
export class ReorderFolderCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.reorderFolder";
  readonly byteSize: number;
  readonly folderId: string;
  readonly from: number;
  readonly to: number;

  constructor(folderId: string, from: number, to: number) {
    this.folderId = folderId;
    this.from = from;
    this.to = to;
    this.byteSize = snapshotBytes({ folderId, from, to });
  }

  apply(doc: SerializedScene): SerializedScene {
    const index = doc.folders.findIndex((folder) => folder.id === this.folderId);
    if (index === -1) return doc;
    const folders = [...doc.folders];
    const [moved] = folders.splice(index, 1);
    folders.splice(Math.max(0, Math.min(this.to, folders.length)), 0, moved!);
    return { ...doc, folders };
  }

  invert(): ReorderFolderCommand {
    return new ReorderFolderCommand(this.folderId, this.to, this.from);
  }
}

/** Editor-only SceneLayer tab flag; `undefined` removes the key. */
export class SetSceneOverlayEditorCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.setOverlayEditor";
  readonly byteSize: number;
  readonly from: boolean | undefined;
  readonly to: boolean | undefined;

  constructor(from: boolean | undefined, to: boolean | undefined) {
    this.from = from;
    this.to = to;
    this.byteSize = snapshotBytes({ from, to });
  }

  apply(doc: SerializedScene): SerializedScene {
    const next = { ...doc };
    if (this.to === undefined) delete next.overlayEditor;
    else next.overlayEditor = this.to;
    return next;
  }

  invert(): SetSceneOverlayEditorCommand {
    return new SetSceneOverlayEditorCommand(this.to, this.from);
  }
}

const optionalRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function createSetActorPropertiesCommandFromJson(payload: Record<string, unknown>): SetActorPropertiesCommand {
  return new SetActorPropertiesCommand(String(payload.actorId), optionalRecord(payload.from), optionalRecord(payload.to));
}

export function createSetActorClassCommandFromJson(payload: Record<string, unknown>): SetActorClassCommand {
  return new SetActorClassCommand(String(payload.actorId), String(payload.from), String(payload.to));
}

export function createSetComponentClassCommandFromJson(payload: Record<string, unknown>): SetComponentClassCommand {
  return new SetComponentClassCommand(String(payload.actorId), String(payload.componentId), String(payload.from), String(payload.to));
}

export function createSetComponentTransformPresenceCommandFromJson(
  payload: Record<string, unknown>,
): SetComponentTransformPresenceCommand {
  return new SetComponentTransformPresenceCommand(String(payload.actorId), String(payload.componentId),
    payload.from as SerializedTransform | undefined, payload.to as SerializedTransform | undefined);
}

export function createReorderFolderCommandFromJson(payload: Record<string, unknown>): ReorderFolderCommand {
  return new ReorderFolderCommand(String(payload.folderId), Number(payload.from), Number(payload.to));
}

export function createSetSceneOverlayEditorCommandFromJson(payload: Record<string, unknown>): SetSceneOverlayEditorCommand {
  const flag = (value: unknown) => typeof value === "boolean" ? value : undefined;
  return new SetSceneOverlayEditorCommand(flag(payload.from), flag(payload.to));
}
