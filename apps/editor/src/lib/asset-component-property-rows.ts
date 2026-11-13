import { PARTICLE_RETRIGGER_LABELS, PARTICLE_RETRIGGER_MODES, parseParticleRetrigger, type SerializedComponent } from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import { normalizeModelPayload } from "@haptic/assets";
import {
  asNumber,
  assetRow,
  componentPropertyGuid,
  genericRows,
  rowId,
  sortingLayerRow,
  shadingModeRow,
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
    shadingModeRow(actorId, component, update),
    unlitCastShadowsRow(actorId, component, update),
    ...genericRows(
      actorId,
      component,
      update,
      new Set(["assetGuid", "sortingLayer", "castShadows", "shadingMode"]),
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
    shadingModeRow(actorId, component, update),
    unlitCastShadowsRow(actorId, component, update),
    ...genericRows(
      actorId,
      component,
      update,
      new Set(["assetGuid", "sortingLayer", "castShadows", "shadingMode"]),
    ),
  ];
}

/** Why a 3D Animation Graph cannot play on the actor: its Skeleton is not the one the actor's Model is on. */
function animationGraphSkeletonStatus(
  actorId: string,
  graphGuid: string | null,
  context: ComponentPropertyContext,
): string | undefined {
  if (!graphGuid || context.assetType?.(graphGuid) !== "AnimationGraph3D") return undefined;
  const graph = context.assetPayload?.(graphGuid);
  if (!graph) return undefined;
  const graphSkeleton = typeof graph.skeletonGuid === "string" && graph.skeletonGuid ? graph.skeletonGuid : null;
  const modelGuid = (context.actorComponents?.(actorId) ?? [])
    .flatMap((entry) => entry.classId === "MeshComponent" ? [componentPropertyGuid(entry, "assetGuid")] : [])
    .find((guid): guid is string => Boolean(guid) && context.assetType?.(guid) === "Model");
  if (!modelGuid) return undefined;
  const modelSkeleton = normalizeModelPayload(context.assetPayload?.(modelGuid) ?? {}).skeletonGuid;
  if (modelSkeleton === graphSkeleton) return undefined;
  return "The graph's Skeleton differs from the actor's Model's, so its Animations will not play.";
}

export function animationGraphPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const graphRow = assetRow(
    actorId,
    component,
    "graphGuid",
    "Animation Graph",
    ["AnimationGraph3D", "AnimationGraph2D"],
    update,
    context,
    "Pick Animation Graph",
  );
  const status = animationGraphSkeletonStatus(actorId, componentPropertyGuid(component, "graphGuid"), context);
  return [
    status ? { ...graphRow, status } : graphRow,
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
    {
      kind: "enum",
      id: rowId(actorId, component.id, "retrigger"),
      label: "Retrigger",
      description: "What Play does while the effect is still on screen. Overlap lets it finish while a new run starts; Restart cuts it.",
      value: parseParticleRetrigger(component.properties.retrigger),
      options: PARTICLE_RETRIGGER_MODES.map((mode) => ({ value: mode, label: PARTICLE_RETRIGGER_LABELS[mode] })),
      onChange: (next) => update("retrigger", next),
    },
    sortingLayerRow(actorId, component, update, context.sortingLayers),
    ...genericRows(
      actorId,
      component,
      update,
      // Parameter Overrides has its own Parameters grid.
      new Set(["particleSystemGuid", "playOnStart", "retrigger", "sortingLayer", "parameterOverrides"]),
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
