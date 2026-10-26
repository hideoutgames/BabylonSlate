import type { SerializedComponent } from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import { parseNavMeshActorSettings } from "@haptic/navigation";
import { asNumber, rowId, type ComponentPropertyUpdate } from "./component-property-row-helpers";

export function navMeshPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  const settings = parseNavMeshActorSettings(component.properties);
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
      unit: "deg",
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
      id: rowId(actorId, component.id, "autoBakeOnSave"),
      label: "Auto Bake On Save",
      value: settings.autoBakeOnSave,
      onChange: (next) => update("autoBakeOnSave", next),
    },
    {
      kind: "boolean",
      id: rowId(actorId, component.id, "bakeBoundsEnabled"),
      label: "Bake Bounds",
      value: settings.bakeBoundsEnabled,
      onChange: (next) => update("bakeBoundsEnabled", next),
    },
    {
      kind: "vector3",
      id: rowId(actorId, component.id, "bakeBoundsMin"),
      label: "Bake Bounds Min",
      value: [
        settings.bakeBoundsMin.x,
        settings.bakeBoundsMin.y,
        settings.bakeBoundsMin.z,
      ],
      onChange: (value) =>
        update("bakeBoundsMin", { x: value[0], y: value[1], z: value[2] }),
    },
    {
      kind: "vector3",
      id: rowId(actorId, component.id, "bakeBoundsMax"),
      label: "Bake Bounds Max",
      value: [
        settings.bakeBoundsMax.x,
        settings.bakeBoundsMax.y,
        settings.bakeBoundsMax.z,
      ],
      onChange: (value) =>
        update("bakeBoundsMax", { x: value[0], y: value[1], z: value[2] }),
    },
  ];
}

export function navAgentPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
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
}

export function navMeshBlockerPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
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
    ...(component.properties.area === "cost"
      ? [
          {
            kind: "number" as const,
            id: rowId(actorId, component.id, "cost"),
            label: "Cost",
            value: asNumber(component.properties.cost, 10),
            min: 1.01,
            onChange: (next: number) => update("cost", next),
          },
        ]
      : []),
  ];
}
