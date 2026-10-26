import { parseAreaRectLightProperties, type SerializedComponent } from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import {
  asNumber,
  assetRow,
  genericRows,
  rowId,
  sliderRow,
  type ComponentPropertyContext,
  type ComponentPropertyUpdate,
} from "./component-property-row-helpers";

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

export function lightPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  const color = asRgb(component.properties.color) ?? [1, 1, 1];
  const lightKind = String(component.properties.lightKind ?? "point");
  const rows: PropertyRow[] = [
    {
      kind: "boolean",
      id: rowId(actorId, component.id, "enabled"),
      label: "Enabled",
      description: "Viewport light icons: white means operating as configured, yellow means requested shadows are limited or unavailable, and red means disabled or not illuminating. Color remains the authored lighting color.",
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
    {
      kind: "number",
      id: rowId(actorId, component.id, "shadowPriority"),
      label: "Shadow Priority",
      value: asNumber(component.properties.shadowPriority, 0),
      onChange: (next) => update("shadowPriority", next),
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
        unit: "deg",
        value: asNumber(component.properties.innerAngle, 30),
        min: 0,
        max: 179,
        onChange: (next) => update("innerAngle", next),
      },
      {
        kind: "number",
        id: rowId(actorId, component.id, "outerAngle"),
        label: "Outer Angle",
        unit: "deg",
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
        "shadowPriority",
      ]),
    ),
  );
  return rows;
}

export function hemisphericFillLightPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
): PropertyRow[] {
  const color = asRgb(component.properties.color) ?? [1, 1, 1];
  const groundColor = asRgb(component.properties.groundColor) ?? [0, 0, 0];
  return [
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
    {
      kind: "color",
      id: rowId(actorId, component.id, "groundColor"),
      label: "Ground Color",
      value: groundColor,
      onChange: (next) => update("groundColor", next),
    },
    sliderRow(
      actorId,
      component.id,
      "intensity",
      "Intensity",
      asNumber(component.properties.intensity, 0.9),
      0,
      16,
      update,
    ),
    ...genericRows(
      actorId,
      component,
      update,
      new Set(["enabled", "color", "groundColor", "intensity"]),
    ),
  ];
}

export function areaRectLightPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const properties = parseAreaRectLightProperties(component.properties);
  return [
    { kind: "boolean", id: rowId(actorId, component.id, "enabled"), label: "Enabled", value: properties.enabled,
      description: "Unshadowed: this light can illuminate through walls. It emits along the component's forward direction (+Z).", onChange: (next) => update("enabled", next) },
    ...(["width", "height"] as const).map((key): PropertyRow => ({ kind: "number", id: rowId(actorId, component.id, key), label: key === "width" ? "Width" : "Height", value: properties[key], min: 0.0001, description: "Local units. Actor and parent scale apply once. Sheared transforms are unsupported.", onChange: (next) => update(key, next) })),
    { kind: "color", id: rowId(actorId, component.id, "color"), label: "Color", value: properties.color, onChange: (next) => update("color", next) },
    { kind: "number", id: rowId(actorId, component.id, "intensity"), label: "Intensity", value: properties.intensity, min: 0, onChange: (next) => update("intensity", next) },
    { ...assetRow(actorId, component, "textureGuid", "Emission Texture", ["Texture"], update, context, "Choose Emission Texture", "Uniform Emission"),
      description: properties.textureGuid ? context.areaEmissionStatus?.(properties.textureGuid) : undefined },
  ];
}
