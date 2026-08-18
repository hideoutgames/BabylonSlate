import type { PropertyRow } from "@babylonslate/editor-kit";
import {
  assetRowIdentity,
  walkAncestry,
  type ClassPickerEntry,
} from "@babylonslate/editor-kit";
import {
  isEditorGraphClass,
  userInterfaceClassId,
  type SerializedComponent,
} from "@babylonslate/core";
import {
  parseColliderProperties,
  type ColliderShape,
} from "@babylonslate/physics";
import {
  ENGINE_BASE_CLASS_IDS,
  ENGINE_COMPONENT_CLASS_IDS,
} from "@babylonslate/object-model";
import { classParentLookup, classIdFromClassAsset } from "./content-browser-helpers";

const MESH_KINDS = ["box", "sphere", "cylinder", "plane", "ground"];
const MOTION_TYPES = ["static", "kinematic", "dynamic"] as const;
const SHAPE_KINDS_3D = ["box", "sphere", "capsule"] as const;
const SHAPE_KINDS_2D = ["box2d", "circle", "capsule2d"] as const;
const POINT_CLOUD_KINDS = new Set(["convex", "mesh", "polygon", "chain"]);
const PHYSICS_LAYER_LABELS = Array.from(
  { length: 32 },
  (_, bit) => `Layer ${bit}`,
);

export type AssetPickRequest = {
  componentId: string;
  property: string;
  allowedTypes: string[];
  title?: string;
};

export type ComponentPropertyContext = {
  sortingLayers: readonly string[];
  assetLabel: (guid: string | null | undefined) => string | undefined;
  assetType?: (guid: string | null | undefined) => string | undefined;
  physicsWorld: "3d" | "2d";
  onPickAsset: (request: AssetPickRequest) => void;
};

function rowId(actorId: string, componentId: string, key: string): string {
  return `${actorId}-${componentId}-${key}`;
}

function guidValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function assetRow(
  actorId: string,
  component: SerializedComponent,
  property: string,
  label: string,
  allowedTypes: string[],
  update: (property: string, value: unknown) => void,
  context: ComponentPropertyContext,
  title?: string,
  placeholder = "None",
): PropertyRow {
  const value = guidValue(component.properties[property]);
  const name = value ? context.assetLabel(value) : undefined;
  const type = value
    ? (context.assetType?.(value) ?? allowedTypes[0])
    : undefined;
  const identity =
    name && type ? assetRowIdentity({ name, type }) : {};
  return {
    kind: "asset",
    id: rowId(actorId, component.id, property),
    label,
    value,
    displayLabel: identity.displayLabel ?? name,
    displayType: identity.displayType,
    visual: identity.visual,
    placeholder,
    onPick: () =>
      context.onPickAsset({
        componentId: component.id,
        property,
        allowedTypes,
        title,
      }),
    onChange: (next) => update(property, next),
  };
}

function defaultShape(kind: string): ColliderShape {
  switch (kind) {
    case "sphere":
      return { kind: "sphere", radius: 0.5 };
    case "capsule":
      return { kind: "capsule", radius: 0.25, halfHeight: 0.5 };
    case "box2d":
      return { kind: "box2d", halfExtents: { x: 0.5, y: 0.5 } };
    case "circle":
      return { kind: "circle", radius: 0.5 };
    case "capsule2d":
      return { kind: "capsule2d", radius: 0.25, halfHeight: 0.5 };
    case "convex":
      return { kind: "convex", points: [] };
    case "mesh":
      return { kind: "mesh", vertices: [], indices: [] };
    case "polygon":
      return { kind: "polygon", points: [] };
    case "chain":
      return { kind: "chain", points: [] };
    case "box":
    default:
      return { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } };
  }
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sliderRow(
  actorId: string,
  componentId: string,
  key: string,
  label: string,
  value: number,
  min: number,
  max: number,
  update: (property: string, value: unknown) => void,
  step?: number,
): PropertyRow {
  return {
    kind: "slider",
    id: rowId(actorId, componentId, key),
    label,
    value,
    min,
    max,
    step,
    onChange: (next) => update(key, next),
  };
}

function flagsRow(
  actorId: string,
  componentId: string,
  key: string,
  label: string,
  value: number,
  update: (property: string, value: unknown) => void,
): PropertyRow {
  return {
    kind: "flags",
    id: rowId(actorId, componentId, key),
    label,
    value,
    bitCount: 32,
    labels: PHYSICS_LAYER_LABELS,
    onChange: (next) => update(key, next),
  };
}

function asRgb(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [r, g, b] = value;
  if (
    typeof r !== "number" ||
    typeof g !== "number" ||
    typeof b !== "number"
  ) {
    return null;
  }
  return [r, g, b];
}

function colliderShapeRows(
  actorId: string,
  component: SerializedComponent,
  update: (property: string, value: unknown) => void,
  physicsWorld: "3d" | "2d",
): PropertyRow[] {
  const parsed = parseColliderProperties(component.properties, physicsWorld);
  const shape = parsed.shape;
  const kinds: string[] =
    physicsWorld === "2d" ? [...SHAPE_KINDS_2D] : [...SHAPE_KINDS_3D];
  if (!kinds.includes(shape.kind)) {
    kinds.push(shape.kind);
  }
  const rows: PropertyRow[] = [
    {
      kind: "enum",
      id: rowId(actorId, component.id, "shape-kind"),
      label: "Shape Kind",
      value: shape.kind,
      options: kinds.map((kind) => ({ value: kind, label: kind })),
      onChange: (next) => update("shape", defaultShape(next)),
    },
  ];

  if (shape.kind === "box") {
    rows.push({
      kind: "vector3",
      id: rowId(actorId, component.id, "shape-half-extents"),
      label: "Half Extents",
      value: [shape.halfExtents.x, shape.halfExtents.y, shape.halfExtents.z],
      onChange: (value) =>
        update("shape", {
          kind: "box",
          halfExtents: { x: value[0], y: value[1], z: value[2] },
        }),
    });
  } else if (shape.kind === "box2d") {
    rows.push({
      kind: "vector3",
      id: rowId(actorId, component.id, "shape-half-extents"),
      label: "Half Extents",
      value: [shape.halfExtents.x, shape.halfExtents.y, 0],
      axes: ["X", "Y"],
      onChange: (value) =>
        update("shape", {
          kind: "box2d",
          halfExtents: { x: value[0], y: value[1] },
        }),
    });
  } else if (shape.kind === "sphere" || shape.kind === "circle") {
    rows.push({
      kind: "number",
      id: rowId(actorId, component.id, "shape-radius"),
      label: "Radius",
      value: shape.radius,
      min: 0,
      onChange: (radius) => update("shape", { ...shape, radius }),
    });
  } else if (shape.kind === "capsule" || shape.kind === "capsule2d") {
    rows.push(
      {
        kind: "number",
        id: rowId(actorId, component.id, "shape-radius"),
        label: "Radius",
        value: shape.radius,
        min: 0,
        onChange: (radius) => update("shape", { ...shape, radius }),
      },
      {
        kind: "number",
        id: rowId(actorId, component.id, "shape-half-height"),
        label: "Half Height",
        value: shape.halfHeight,
        min: 0,
        onChange: (halfHeight) => update("shape", { ...shape, halfHeight }),
      },
    );
  } else if (!POINT_CLOUD_KINDS.has(shape.kind)) {
    // Unknown primitive — no extra numeric fields.
  }

  return rows;
}

function genericRows(
  actorId: string,
  component: SerializedComponent,
  update: (property: string, value: unknown) => void,
  skip: ReadonlySet<string>,
): PropertyRow[] {
  const rows: PropertyRow[] = [];
  for (const [key, value] of Object.entries(component.properties)) {
    if (skip.has(key)) continue;
    const id = rowId(actorId, component.id, key);
    if (typeof value === "number") {
      rows.push({
        kind: "number",
        id,
        label: key,
        value,
        onChange: (next) => update(key, next),
      });
      continue;
    }
    if (typeof value === "boolean") {
      rows.push({
        kind: "boolean",
        id,
        label: key,
        value,
        onChange: (next) => update(key, next),
      });
      continue;
    }
    if (Array.isArray(value) && value.length === 3) {
      rows.push({
        kind: "vector3",
        id,
        label: key,
        value: value as [number, number, number],
        onChange: (next) => update(key, next),
      });
      continue;
    }
    rows.push({
      kind: "text",
      id,
      label: key,
      value: value === null || value === undefined ? "" : String(value),
      onChange: (next) => update(key, next === "" ? null : next),
    });
  }
  return rows;
}

function sortingLayerRow(
  actorId: string,
  component: SerializedComponent,
  update: (property: string, value: unknown) => void,
  sortingLayers: readonly string[],
): PropertyRow {
  const value =
    typeof component.properties.sortingLayer === "string"
      ? component.properties.sortingLayer
      : "Default";
  const options = sortingLayers.includes(value)
    ? sortingLayers
    : [...sortingLayers, value];
  return {
    kind: "enum",
    id: rowId(actorId, component.id, "sortingLayer"),
    label: "Sorting Layer",
    value,
    options: options.map((layer) => ({ value: layer, label: layer })),
    onChange: (next) => update("sortingLayer", next),
  };
}

/** Typed Details rows for a serialized component (asset picks, physics flatten). */
export function componentPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: (property: string, value: unknown) => void,
  context: ComponentPropertyContext,
): PropertyRow[] {
  switch (component.classId) {
    case "MeshComponent":
      return [
        {
          kind: "enum",
          id: rowId(actorId, component.id, "meshKind"),
          label: "Mesh Kind",
          value: String(component.properties.meshKind ?? "box"),
          options: MESH_KINDS.map((kind) => ({ value: kind, label: kind })),
          onChange: (next) => update("meshKind", next),
        },
        assetRow(
          actorId,
          component,
          "assetGuid",
          "Asset",
          ["Mesh", "Model"],
          update,
          context,
          "Pick Mesh",
        ),
        assetRow(
          actorId,
          component,
          "materialGuid",
          "Material",
          ["Material"],
          update,
          context,
          "Pick Material",
        ),
        ...genericRows(
          actorId,
          component,
          update,
          new Set(["meshKind", "assetGuid", "materialGuid"]),
        ),
      ];
    case "SpriteComponent":
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
        ...genericRows(
          actorId,
          component,
          update,
          new Set(["assetGuid", "sortingLayer"]),
        ),
      ];
    case "TilemapComponent":
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
        ...genericRows(
          actorId,
          component,
          update,
          new Set(["assetGuid", "sortingLayer"]),
        ),
      ];
    case "WidgetComponent":
      return [
        assetRow(
          actorId,
          component,
          "uiAssetGuid",
          "User Interface",
          ["UserInterface"],
          update,
          context,
          "Pick User Interface",
        ),
        ...genericRows(actorId, component, update, new Set(["uiAssetGuid"])),
      ];
    case "AnimationGraphComponent":
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
    case "BehaviourTreeComponent":
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
    case "AudioComponent":
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
    case "NavMeshComponent": {
      const settings = {
        tiled: component.properties.tiled === true,
        supportDynamicObstacles:
          component.properties.supportDynamicObstacles === true,
        autoBakeOnSave: component.properties.autoBakeOnSave === true,
        debugOverlay: component.properties.debugOverlay === true,
      };
      return [
        {
          kind: "number",
          id: rowId(actorId, component.id, "cellSize"),
          label: "Cell Size",
          value: asNumber(component.properties.cellSize, 0.2),
          min: 0.05,
          onChange: (next) => update("cellSize", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "cellHeight"),
          label: "Cell Height",
          value: asNumber(component.properties.cellHeight, 0.2),
          min: 0.05,
          onChange: (next) => update("cellHeight", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "walkableSlopeAngle"),
          label: "Walkable Slope Angle",
          value: asNumber(component.properties.walkableSlopeAngle, 60),
          min: 0,
          max: 90,
          onChange: (next) => update("walkableSlopeAngle", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "walkableHeight"),
          label: "Walkable Height",
          value: asNumber(component.properties.walkableHeight, 2),
          min: 0,
          onChange: (next) => update("walkableHeight", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "walkableClimb"),
          label: "Walkable Climb",
          value: asNumber(component.properties.walkableClimb, 2),
          min: 0,
          onChange: (next) => update("walkableClimb", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "walkableRadius"),
          label: "Walkable Radius",
          value: asNumber(component.properties.walkableRadius, 0.5),
          min: 0,
          onChange: (next) => update("walkableRadius", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "maxEdgeLen"),
          label: "Max Edge Length",
          value: asNumber(component.properties.maxEdgeLen, 12),
          min: 0,
          onChange: (next) => update("maxEdgeLen", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "maxSimplificationError"),
          label: "Max Simplification Error",
          value: asNumber(component.properties.maxSimplificationError, 1.3),
          min: 0,
          onChange: (next) => update("maxSimplificationError", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "minRegionArea"),
          label: "Min Region Area",
          value: asNumber(component.properties.minRegionArea, 8),
          min: 0,
          onChange: (next) => update("minRegionArea", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "mergeRegionArea"),
          label: "Merge Region Area",
          value: asNumber(component.properties.mergeRegionArea, 20),
          min: 0,
          onChange: (next) => update("mergeRegionArea", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "maxVertsPerPoly"),
          label: "Max Verts Per Polygon",
          value: asNumber(component.properties.maxVertsPerPoly, 6),
          min: 3,
          onChange: (next) => update("maxVertsPerPoly", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "detailSampleDist"),
          label: "Detail Sample Distance",
          value: asNumber(component.properties.detailSampleDist, 6),
          min: 0,
          onChange: (next) => update("detailSampleDist", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "detailSampleMaxError"),
          label: "Detail Sample Max Error",
          value: asNumber(component.properties.detailSampleMaxError, 1),
          min: 0,
          onChange: (next) => update("detailSampleMaxError", next),
        },
        {
          kind: "enum",
          id: rowId(actorId, component.id, "tiled"),
          label: "Generate",
          value: settings.tiled ? "tiled" : "solo",
          options: [
            { value: "solo", label: "Solo" },
            { value: "tiled", label: "Tiled" },
          ],
          onChange: (next) => update("tiled", next === "tiled"),
        },
        {
          kind: "boolean",
          id: rowId(actorId, component.id, "supportDynamicObstacles"),
          label: "Support Dynamic Obstacles",
          value: settings.supportDynamicObstacles,
          onChange: (next) => update("supportDynamicObstacles", next),
        },
        {
          kind: "boolean",
          id: rowId(actorId, component.id, "debugOverlay"),
          label: "Debug Overlay",
          value: settings.debugOverlay,
          onChange: (next) => update("debugOverlay", next),
        },
      ];
    }
    case "NavAgentComponent":
      return [
        {
          kind: "number",
          id: rowId(actorId, component.id, "radius"),
          label: "Radius",
          value: asNumber(component.properties.radius, 0.5),
          min: 0.05,
          onChange: (next) => update("radius", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "height"),
          label: "Height",
          value: asNumber(component.properties.height, 2),
          min: 0.1,
          onChange: (next) => update("height", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "maxSpeed"),
          label: "Max Speed",
          value: asNumber(component.properties.maxSpeed, 3.5),
          min: 0,
          onChange: (next) => update("maxSpeed", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "maxAcceleration"),
          label: "Max Acceleration",
          value: asNumber(component.properties.maxAcceleration, 8),
          min: 0,
          onChange: (next) => update("maxAcceleration", next),
        },
      ];
    case "NavMeshBlockerComponent":
      return [
        {
          kind: "boolean",
          id: rowId(actorId, component.id, "dynamic"),
          label: "Dynamic",
          value: component.properties.dynamic === true,
          onChange: (next) => update("dynamic", next),
        },
        {
          kind: "enum",
          id: rowId(actorId, component.id, "kind"),
          label: "Kind",
          value:
            component.properties.kind === "cylinder" ? "cylinder" : "box",
          options: [
            { value: "box", label: "Box" },
            { value: "cylinder", label: "Cylinder" },
          ],
          onChange: (next) => update("kind", next),
        },
        {
          kind: "enum",
          id: rowId(actorId, component.id, "area"),
          label: "Area",
          value: component.properties.area === "cost" ? "cost" : "unwalkable",
          options: [
            { value: "unwalkable", label: "Unwalkable" },
            { value: "cost", label: "Cost" },
          ],
          onChange: (next) => update("area", next),
        },
      ];
    case "RigidBodyComponent":
      return [
        {
          kind: "enum",
          id: rowId(actorId, component.id, "motionType"),
          label: "Motion Type",
          value:
            component.properties.motionType === "static" ||
            component.properties.motionType === "kinematic" ||
            component.properties.motionType === "dynamic"
              ? component.properties.motionType
              : "dynamic",
          options: MOTION_TYPES.map((type) => ({ value: type, label: type })),
          onChange: (next) => update("motionType", next),
        },
        sliderRow(
          actorId,
          component.id,
          "gravityScale",
          "Gravity Scale",
          asNumber(component.properties.gravityScale, 1),
          0,
          10,
          update,
        ),
        sliderRow(
          actorId,
          component.id,
          "linearDamping",
          "Linear Damping",
          asNumber(component.properties.linearDamping, 0),
          0,
          10,
          update,
        ),
        sliderRow(
          actorId,
          component.id,
          "angularDamping",
          "Angular Damping",
          asNumber(component.properties.angularDamping, 0),
          0,
          10,
          update,
        ),
        ...genericRows(
          actorId,
          component,
          update,
          new Set([
            "motionType",
            "gravityScale",
            "linearDamping",
            "angularDamping",
          ]),
        ),
      ];
    case "ColliderComponent":
      return [
        ...colliderShapeRows(
          actorId,
          component,
          update,
          context.physicsWorld,
        ),
        sliderRow(
          actorId,
          component.id,
          "friction",
          "Friction",
          asNumber(component.properties.friction, 0.5),
          0,
          1,
          update,
        ),
        sliderRow(
          actorId,
          component.id,
          "restitution",
          "Restitution",
          asNumber(component.properties.restitution, 0),
          0,
          1,
          update,
        ),
        flagsRow(
          actorId,
          component.id,
          "layer",
          "Layer",
          asNumber(component.properties.layer, 1),
          update,
        ),
        flagsRow(
          actorId,
          component.id,
          "mask",
          "Mask",
          asNumber(component.properties.mask, 0xffffffff),
          update,
        ),
        ...genericRows(
          actorId,
          component,
          update,
          new Set(["shape", "friction", "restitution", "layer", "mask"]),
        ),
      ];
    case "LightComponent": {
      const color = asRgb(component.properties.color) ?? [1, 1, 1];
      const lightKind = String(component.properties.lightKind ?? "point");
      const rows: PropertyRow[] = [
        {
          kind: "boolean",
          id: rowId(actorId, component.id, "enabled"),
          label: "Enabled",
          value: component.properties.enabled !== false,
          onChange: (next) => update("enabled", next),
        },
        {
          kind: "color",
          id: rowId(actorId, component.id, "color"),
          label: "Color",
          value: color,
          onChange: (next) => update("color", next),
        },
        sliderRow(
          actorId,
          component.id,
          "intensity",
          "Intensity",
          asNumber(component.properties.intensity, 1),
          0,
          16,
          update,
        ),
        {
          kind: "enum",
          id: rowId(actorId, component.id, "lightKind"),
          label: "Light Kind",
          value: lightKind,
          options: [
            { value: "point", label: "Point" },
            { value: "spot", label: "Spot" },
            { value: "directional", label: "Directional" },
          ],
          onChange: (next) => update("lightKind", next),
        },
        {
          kind: "boolean",
          id: rowId(actorId, component.id, "castShadows"),
          label: "Cast Shadows",
          value: component.properties.castShadows === true,
          onChange: (next) => update("castShadows", next),
        },
      ];
      if (lightKind !== "directional") {
        rows.push({
          kind: "number",
          id: rowId(actorId, component.id, "range"),
          label: "Range",
          value: asNumber(component.properties.range, 10),
          min: 0,
          onChange: (next) => update("range", next),
        });
      }
      if (lightKind === "spot") {
        rows.push(
          {
            kind: "number",
            id: rowId(actorId, component.id, "innerAngle"),
            label: "Inner Angle",
            value: asNumber(component.properties.innerAngle, 30),
            min: 0,
            max: 179,
            onChange: (next) => update("innerAngle", next),
          },
          {
            kind: "number",
            id: rowId(actorId, component.id, "outerAngle"),
            label: "Outer Angle",
            value: asNumber(component.properties.outerAngle, 45),
            min: 1,
            max: 179,
            onChange: (next) => update("outerAngle", next),
          },
        );
      }
      rows.push(
        ...genericRows(
          actorId,
          component,
          update,
          new Set([
            "color",
            "intensity",
            "lightKind",
            "range",
            "outerAngle",
            "innerAngle",
            "enabled",
            "castShadows",
          ]),
        ),
      );
      return rows;
    }
    case "CameraComponent": {
      const projectionMode =
        component.properties.projectionMode === "orthographic"
          ? "orthographic"
          : "perspective";
      return [
        {
          kind: "enum",
          id: rowId(actorId, component.id, "projectionMode"),
          label: "Projection Mode",
          value: projectionMode,
          options: [
            { value: "perspective", label: "Perspective" },
            { value: "orthographic", label: "Orthographic" },
          ],
          onChange: (next) => update("projectionMode", next),
        },
        sliderRow(
          actorId,
          component.id,
          "fieldOfView",
          "Field Of View",
          asNumber(component.properties.fieldOfView, 60),
          1,
          179,
          update,
          1,
        ),
        sliderRow(
          actorId,
          component.id,
          "orthographicSize",
          "Orthographic Size",
          asNumber(component.properties.orthographicSize, 5),
          0.1,
          50,
          update,
        ),
        {
          kind: "number",
          id: rowId(actorId, component.id, "nearClip"),
          label: "Near Clip",
          value: asNumber(component.properties.nearClip, 0.1),
          min: 0.001,
          onChange: (next) => update("nearClip", next),
        },
        {
          kind: "number",
          id: rowId(actorId, component.id, "farClip"),
          label: "Far Clip",
          value: asNumber(component.properties.farClip, 1000),
          min: 0.01,
          onChange: (next) => update("farClip", next),
        },
        {
          kind: "boolean",
          id: rowId(actorId, component.id, "attemptPossessViewTarget"),
          label: "Attempt Possess View Target",
          value: component.properties.attemptPossessViewTarget === true,
          defaultValue: false,
          onChange: (next) => update("attemptPossessViewTarget", next),
        },
        ...genericRows(
          actorId,
          component,
          update,
          new Set([
            "fieldOfView",
            "orthographicSize",
            "projectionMode",
            "nearClip",
            "farClip",
            "attemptPossessViewTarget",
          ]),
        ),
      ];
    }
    default:
      return genericRows(actorId, component, update, new Set());
  }
}

/** Engine GameInstance plus project Class assets in that lineage. */
export function gameInstanceClassEntries(
  assets: ReadonlyArray<{
    path?: string;
    header: { type: string; name: string; parentClass?: string | null };
  }>,
): ClassPickerEntry[] {
  const parentOf = classParentLookup(assets);
  const entries: ClassPickerEntry[] = [
    { id: "GameInstance", name: "Game Instance", group: "Engine" },
  ];
  for (const asset of assets) {
    if (asset.header.type !== "Class") continue;
    const id = classIdFromClassAsset(asset);
    if (id === "GameInstance") continue;
    if (!walkAncestry(id, parentOf).includes("GameInstance")) continue;
    entries.push({ id, name: id, group: "Project" });
  }
  return entries;
}

/** Engine plus project Class assets assignable to a classRef constraint. */
export function subclassClassEntries(
  baseClassId: string,
  assets: ReadonlyArray<{
    path?: string;
    header: {
      type: string;
      name: string;
      parentClass?: string | null;
      guid?: string;
    };
  }>,
  options?: { editorGraph?: boolean },
): ClassPickerEntry[] {
  const parentOf = classParentLookup(assets);
  const entries: ClassPickerEntry[] = [];
  const seen = new Set<string>();
  const add = (id: string, name: string, group: string) => {
    if (seen.has(id)) return;
    if (!walkAncestry(id, parentOf).includes(baseClassId)) return;
    if (options?.editorGraph !== true && isEditorGraphClass(id, parentOf)) {
      return;
    }
    seen.add(id);
    entries.push({ id, name, group });
  };
  add(baseClassId, baseClassId, "Engine");
  for (const id of ENGINE_BASE_CLASS_IDS) add(id, id, "Engine");
  for (const id of ENGINE_COMPONENT_CLASS_IDS) add(id, id, "Engine");
  for (const asset of assets) {
    if (asset.header.type === "UserInterface" && asset.header.guid) {
      add(
        userInterfaceClassId(asset.header.guid),
        asset.header.name || asset.header.guid,
        "Project",
      );
      continue;
    }
    if (asset.header.type !== "Class") continue;
    const id = classIdFromClassAsset(asset);
    add(id, id, "Project");
  }
  return entries;
}
