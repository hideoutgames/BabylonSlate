import type { MaterialInstanceOverrides, SerializedScene } from "@babylonslate/core";
import type { EditCommand } from "../command";
import { snapshotBytes } from "../snapshot-bytes";

export class SetActorSuppressedComponentsCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.setActorSuppressedComponents";
  readonly byteSize: number;
  readonly actorId: string;
  readonly from: readonly string[] | undefined;
  readonly to: readonly string[] | undefined;
  constructor(actorId: string, from: readonly string[] | undefined, to: readonly string[] | undefined) {
    this.actorId = actorId; this.from = from; this.to = to;
    this.byteSize = snapshotBytes({ from, to });
  }
  apply(doc: SerializedScene): SerializedScene {
    return { ...doc, actors: doc.actors.map((actor) => {
      if (actor.id !== this.actorId) return actor;
      const next = { ...actor };
      if (this.to === undefined) delete next.suppressedComponentSourceIds;
      else next.suppressedComponentSourceIds = [...this.to];
      return next;
    }) };
  }
  invert(): SetActorSuppressedComponentsCommand {
    return new SetActorSuppressedComponentsCommand(this.actorId, this.to, this.from);
  }
}

export class SetComponentMaterialInstanceCommand implements EditCommand<SerializedScene> {
  readonly type = "scene.setComponentMaterialInstance";
  readonly byteSize: number;
  readonly actorId: string;
  readonly componentId: string;
  readonly from: MaterialInstanceOverrides | undefined;
  readonly to: MaterialInstanceOverrides | undefined;
  constructor(actorId: string, componentId: string,
    from: MaterialInstanceOverrides | undefined, to: MaterialInstanceOverrides | undefined) {
    this.actorId = actorId; this.componentId = componentId; this.from = from; this.to = to;
    this.byteSize = snapshotBytes({ from, to });
  }
  apply(doc: SerializedScene): SerializedScene {
    return { ...doc, actors: doc.actors.map((actor) => actor.id !== this.actorId ? actor : {
      ...actor, components: actor.components.map((component) => {
        if (component.id !== this.componentId) return component;
        const next = { ...component };
        if (this.to === undefined) delete next.materialInstance;
        else next.materialInstance = structuredClone(this.to);
        return next;
      }),
    }) };
  }
  invert(): SetComponentMaterialInstanceCommand {
    return new SetComponentMaterialInstanceCommand(this.actorId, this.componentId, this.to, this.from);
  }
}

export function createSetActorSuppressedComponentsCommandFromJson(payload: Record<string, unknown>): SetActorSuppressedComponentsCommand {
  return new SetActorSuppressedComponentsCommand(String(payload.actorId), payload.from as string[] | undefined, payload.to as string[] | undefined);
}

export function createSetComponentMaterialInstanceCommandFromJson(payload: Record<string, unknown>): SetComponentMaterialInstanceCommand {
  return new SetComponentMaterialInstanceCommand(String(payload.actorId), String(payload.componentId),
    payload.from as MaterialInstanceOverrides | undefined, payload.to as MaterialInstanceOverrides | undefined);
}
