import { normalizeWaterBody, normalizeWaterBuoyancy, normalizeWaterRemoval, WATER_REMOVAL_SHAPES, waterKindForClass, type SerializedComponent } from "@haptic/core";
import { humanizePropertyLabel, type PropertyRow } from "@haptic/editor-kit";
import { assetRow, rowId, type ComponentPropertyContext, type ComponentPropertyUpdate } from "./component-property-row-helpers";
import { pathPropertyRows } from "./path-property-rows";

export function waterBodyPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  // Dispatched only for water body classes, so the kind is never null.
  const waterKind = waterKindForClass(component.classId)!;
  const body = normalizeWaterBody(component.properties, waterKind);
  const numeric = ([key, label, min, max]: [keyof typeof body, string, number, number]): PropertyRow => ({ kind: "number", id: rowId(actorId, component.id, key), label, value: Number(body[key]), min, max, onChange: (value) => update(key, value) });
  const rows: PropertyRow[] = [
    assetRow(actorId, component, "assetGuid", "Water", ["Water"], update, context, "Pick Water"),
    { kind: "boolean", id: rowId(actorId, component.id, "enabled"), label: "Enabled", value: body.enabled, onChange: (value) => update("enabled", value) },
    ...(waterKind !== "global" ? [numeric(["width", "Width", 0.1, 10000])] : []),
    ...(waterKind !== "river" && waterKind !== "global" ? [numeric(["length", "Length", 0.1, 10000])] : []),
    numeric(["depth", "Depth", 0.01, 10000]), numeric(["waveScale", "Wave Scale", 0, 10]),
    numeric(["flowSpeed", "Flow Speed", -100, 100]),
    ...(waterKind !== "river" ? [numeric(["flowDirection", "Flow Direction", -360, 360])] : []),
    numeric(["resolution", "Surface Resolution", 8, 128]),
  ];
  if (waterKind === "river") {
    rows.push(...pathPropertyRows({
      idPrefix: `${actorId}-${component.id}`,
      points: body.points,
      curvature: body.curvature,
      curvatureDescription: "0 joins points with straight reaches; 1 bends the river smoothly through every point.",
      pointsDescription: "Points run from upstream to downstream in local space. Y sets the water elevation. In the viewport, drag points, drag orange handles to change width, drag a midpoint to add a point, and double-click a point to remove it.",
      extraPointRows: (index) => [
        { kind: "number", id: rowId(actorId, component.id, "point-width-" + index), label: "Path Point " + (index + 1) + " Width Scale", value: body.widthScales[index]!, defaultValue: 1, min: 0.05, max: 20, description: "Multiplies Width at this point.", onChange: (value) => update("widthScales", body.widthScales.map((scale, i) => i === index ? value : scale)) },
      ],
      update,
    }));
  }
  return rows;
}

export function waterRemovalPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  const v = normalizeWaterRemoval(component.properties);
  const size = ([key, label, description]: ["width" | "height" | "length", string, string]): PropertyRow => ({ kind: "number", id: rowId(actorId, component.id, key), label, value: v[key], defaultValue: 4, min: 0.01, max: 10000, description, onChange: (value) => update(key, value) });
  const round = v.shape !== "box";
  return [
    { kind: "boolean", id: rowId(actorId, component.id, "enabled"), label: "Enabled", value: v.enabled, onChange: (value) => update("enabled", value) },
    { kind: "enum", id: rowId(actorId, component.id, "shape"), label: "Shape", value: v.shape, options: WATER_REMOVAL_SHAPES.map((shape) => ({ value: shape, label: humanizePropertyLabel(shape) })), description: "Water inside this shape is removed from every water component, for rendering, queries and buoyancy.", onChange: (value) => update("shape", value) },
    size(["width", round ? "Diameter" : "Width", round ? "Metres across the round shape." : "Metres along local X."]),
    ...(v.shape === "sphere" ? [] : [size(["height", "Height", v.shape === "box" ? "Metres along local Y." : "Total metres along local Y, including rounded ends."])]),
    ...(v.shape === "box" ? [size(["length", "Length", "Metres along local Z."])] : []),
  ];
}

export function waterBuoyancyPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  const b = normalizeWaterBuoyancy(component.properties);
  return [
    { kind: "boolean", id: rowId(actorId, component.id, "enabled"), label: "Enabled", value: b.enabled, onChange: (value) => update("enabled", value) },
    { kind: "number", id: rowId(actorId, component.id, "volume"), label: "Volume", value: b.volume, defaultValue: 0, min: 0, max: 100000, sensitivity: 0.0001, precision: 6, description: "Cubic metres, scaled with the component. Zero is automatic. In default water, 0.002 floats 1 kg halfway submerged; larger volumes float higher. Extra loads push it deeper.", onChange: (value) => update("volume", value) },
    ...(["width", "length", "height", "drag", "angularDrag"] as const).map((key): PropertyRow => ({ kind: "number", id: rowId(actorId, component.id, key), label: humanizePropertyLabel(key), value: b[key], min: key === "drag" || key === "angularDrag" ? 0 : 0.01, onChange: (value) => update(key, value) })),
    { kind: "vector3", id: rowId(actorId, component.id, "offset"), label: "Offset", value: b.offset, onChange: (value) => update("offset", value.slice(0, 3)) },
  ];
}
