import type { SerializedComponent } from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import {
  asNumber,
  assetRow,
  genericRows,
  rowId,
  sortingLayerRow,
  unlitCastShadowsRow,
  type ComponentPropertyContext,
  type ComponentPropertyUpdate,
} from "./component-property-row-helpers";

export function spritePropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return [
    assetRow(
      actorId,
      component,
      "assetGuid",
      "Asset",
      ["Sprite"],
      update,
      context,
      "Pick Sprite",
    ),
    sortingLayerRow(actorId, component, update, context.sortingLayers),
    unlitCastShadowsRow(actorId, component, update),
    ...genericRows(
      actorId,
      component,
      update,
      new Set(["assetGuid", "sortingLayer", "castShadows"]),
    ),
  ];
}

export function tilemapPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return [
    assetRow(
      actorId,
      component,
      "assetGuid",
      "Asset",
      ["Tilemap"],
      update,
      context,
      "Pick Tilemap",
    ),
    sortingLayerRow(actorId, component, update, context.sortingLayers),
    unlitCastShadowsRow(actorId, component, update),
    ...genericRows(
      actorId,
      component,
      update,
      new Set(["assetGuid", "sortingLayer", "castShadows"]),
    ),
  ];
}

export function animationGraphPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return [
    assetRow(
      actorId,
      component,
      "graphGuid",
      "Animation Graph",
      ["AnimationGraph"],
      update,
      context,
      "Pick Animation Graph",
    ),
    ...genericRows(actorId, component, update, new Set(["graphGuid"])),
  ];
}

export function behaviourTreePropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return [
    assetRow(
      actorId,
      component,
      "treeGuid",
      "Behaviour Tree",
      ["BehaviourTree"],
      update,
      context,
      "Pick Behaviour Tree",
    ),
    assetRow(
      actorId,
      component,
      "blackboardGuid",
      "Blackboard",
      ["Blackboard"],
      update,
      context,
      "Pick Blackboard",
    ),
    ...genericRows(
      actorId,
      component,
      update,
      new Set(["treeGuid", "blackboardGuid"]),
    ),
  ];
}

export function audioPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return [
    assetRow(
      actorId,
      component,
      "audioAssetGuid",
      "Audio",
      ["Audio"],
      update,
      context,
      "Pick Audio",
      "Pick Audio — Play On Start needs an asset",
    ),
    {
      kind: "boolean",
      id: rowId(actorId, component.id, "playOnStart"),
      label: "Play On Start",
      value: component.properties.playOnStart !== false,
      onChange: (next) => update("playOnStart", next),
    },
    {
      kind: "boolean",
      id: rowId(actorId, component.id, "loop"),
      label: "Loop",
      value: component.properties.loop === true,
      onChange: (next) => update("loop", next),
    },
    {
      kind: "number",
      id: rowId(actorId, component.id, "volume"),
      label: "Volume",
      value: asNumber(component.properties.volume, 1),
      min: 0,
      max: 1,
      onChange: (next) => update("volume", next),
    },
    ...genericRows(
      actorId,
      component,
      update,
      new Set(["audioAssetGuid", "playOnStart", "loop", "volume"]),
    ),
  ];
}

export function particlePropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return [
    assetRow(
      actorId,
      component,
      "particleSystemGuid",
      "Particle System",
      ["ParticleSystem"],
      update,
      context,
      "Pick Particle System",
    ),
    {
      kind: "boolean",
      id: rowId(actorId, component.id, "playOnStart"),
      label: "Play On Start",
      value: component.properties.playOnStart !== false,
      onChange: (next) => update("playOnStart", next),
    },
    sortingLayerRow(actorId, component, update, context.sortingLayers),
    ...genericRows(
      actorId,
      component,
      update,
      new Set(["particleSystemGuid", "playOnStart", "sortingLayer"]),
    ),
  ];
}

export function sceneStreamingPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return [assetRow(actorId, component, "sceneGuid", "Target Scene", ["Scene"], update, context, "Pick Target Scene")];
}
