import { parseSkyboxFaces, type CollisionPreset, type SerializedComponent, type SkyboxFaceKey } from "@haptic/core";
import type { ModelMaterialSlot } from "@haptic/assets";
import { assetRowIdentity, type ClassPickerEntry, type PropertyRow } from "@haptic/editor-kit";

// Shared rows for the per-family Details builders (*-property-rows.ts) that
// componentPropertyRows dispatches to by class id. Builders are function
// declarations, and no builder module value-imports ./component-property-rows:
// it builds its dispatch table at load, so it must evaluate last.

export type AssetPickRequest = {
  componentId: string;
  property: string;
  allowedTypes: string[];
  title?: string;
  materialDomain?: "text";
};

export type ComponentPropertyContext = {
  sortingLayers: readonly string[];
  collisionLayers: readonly string[];
  /** Project Collision Presets; the Collision Preset row lists them. Omitted: the default preset only. */
  collisionPresets?: readonly CollisionPreset[];
  assetLabel: (guid: string | null | undefined) => string | undefined;
  assetType?: (guid: string | null | undefined) => string | undefined;
  modelMaterialSlots?: (guid: string) => readonly ModelMaterialSlot[];
  fontHasFacetype?: (guid: string | null | undefined) => boolean;
  fontHasMsdfJson?: (guid: string | null | undefined) => boolean;
  fontHasMsdfPng?: (guid: string | null | undefined) => boolean;
  physicsWorld: "3d" | "2d";
  onPickAsset: (request: AssetPickRequest) => void;
  actorLabel?: (actorId: string) => string | undefined;
  actorComponents?: (actorId: string) => readonly SerializedComponent[];
  actorVariableNames?: (actorId: string) => readonly string[];
  componentVariableNames?: (classId: string) => readonly string[];
  onPickActor?: (componentId: string) => void;
  sceneLayerClasses?: readonly ClassPickerEntry[];
  focusTargets?: readonly { value: string; label: string }[];
  /** Why an assigned emission Texture cannot light its emitter yet. */
  areaEmissionStatus?: (guid: string) => string | undefined;
};

export function rowId(actorId: string, componentId: string, key: string): string {
  return `${actorId}-${componentId}-${key}`;
}

export function guidValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function componentPropertyGuid(
  component: SerializedComponent,
  property: string,
): string | null {
  if (property.startsWith("faces.")) {
    const faces = parseSkyboxFaces(component.properties.faces);
    const key = property.slice("faces.".length) as SkyboxFaceKey;
    return guidValue(faces[key]);
  }
  return guidValue(component.properties[property]);
}

export function assetRow(
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
  const value = componentPropertyGuid(component, property);
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

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function sliderRow(
  actorId: string,
  componentId: string,
  key: string,
  label: string,
  value: number,
  min: number,
  max: number,
  update: (property: string, value: unknown) => void,
  step?: number,
  defaultValue?: number,
): PropertyRow {
  return {
    kind: "slider",
    id: rowId(actorId, componentId, key),
    label,
    value,
    min,
    max,
    step,
    defaultValue,
    onChange: (next) => update(key, next),
  };
}

export function genericRows(
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

export function sortingLayerRow(
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

/**
 * Writes one Details property. `alsoSet` carries coupled properties that must
 * land in the same edit; callers apply every write to their render snapshot,
 * so a second call would discard the first.
 */
export type ComponentPropertyUpdate = (
  property: string,
  value: unknown,
  alsoSet?: Readonly<Record<string, unknown>>,
) => void;

/** Details rows for one component class; componentPropertyRows picks one per class id. */
export type ComponentRowBuilder = (
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
) => PropertyRow[];
