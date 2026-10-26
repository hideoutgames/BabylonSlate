import {
  CUSTOM_COLLISION_PRESET,
  DEFAULT_COLLISION_PRESETS,
  findCollisionPreset,
  resolveCollisionFilter,
  type SerializedComponent,
} from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import { asNumber, rowId, type ComponentPropertyContext, type ComponentPropertyUpdate } from "./component-property-row-helpers";

function collisionLayerNames(
  layers: readonly string[] | undefined,
): string[] {
  const names = (layers ?? []).map((name) => name.trim()).filter(Boolean);
  return names.length > 0 ? names : ["Default"];
}

/**
 * Layer Select label for a stored membership mask. A single named bit is that
 * layer; any other mask (no bits, several, or bits past the named layers) is
 * described as its own option, never as a layer the collider is not in.
 */
function layerLabelFromBitmask(
  layer: number,
  names: readonly string[],
): string {
  const labels: string[] = [];
  for (let bit = 0; bit < 32; bit++) {
    if ((layer & (1 << bit)) !== 0) labels.push(names[bit] ?? `Layer ${bit + 1}`);
  }
  return labels.length > 0 ? labels.join(", ") : "None";
}

function collisionLayerRow(
  actorId: string,
  component: SerializedComponent,
  update: (property: string, value: unknown) => void,
  collisionLayers: readonly string[],
  layer = asNumber(component.properties.layer, 1),
  disabled = false,
): PropertyRow {
  const names = collisionLayerNames(collisionLayers);
  const value = layerLabelFromBitmask(layer, names);
  const options = names.includes(value) ? names : [...names, value];
  return {
    kind: "enum",
    id: rowId(actorId, component.id, "layer"),
    label: "Layer",
    value,
    options: options.map((name) => ({ value: name, label: name })),
    disabled,
    onChange: (next) => {
      const bit = names.indexOf(next);
      update("layer", bit >= 0 ? 1 << bit : 1);
    },
  };
}

/**
 * Collision Preset, then Layer and Collision Responses (Ignore / Overlap /
 * Block per layer). A preset supplies them and the rows show its values read
 * only; Custom edits the collider's own. Picking a preset also stores its
 * values on the component, so a later deleted preset falls back to what the
 * collider last used, and switching to Custom starts from them.
 */
export function collisionRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: Pick<ComponentPropertyContext, "collisionLayers" | "collisionPresets">,
): PropertyRow[] {
  const names = collisionLayerNames(context.collisionLayers);
  const presets = context.collisionPresets ?? DEFAULT_COLLISION_PRESETS;
  const preset = findCollisionPreset(presets, component.properties.collisionPreset);
  const resolved = resolveCollisionFilter(
    {
      layer: asNumber(component.properties.layer, 1),
      mask: asNumber(component.properties.mask, 0xffffffff),
      overlapMask: asNumber(component.properties.overlapMask, 0),
    },
    component.properties.collisionPreset,
    presets,
  );
  return [
    {
      kind: "enum",
      id: rowId(actorId, component.id, "collisionPreset"),
      label: "Collision Preset",
      value: preset?.id ?? CUSTOM_COLLISION_PRESET,
      options: [
        ...presets.map((entry) => ({ value: entry.id, label: entry.name })),
        { value: CUSTOM_COLLISION_PRESET, label: "Custom" },
      ],
      onChange: (next) => {
        const picked = presets.find((entry) => entry.id === next);
        const values = resolveCollisionFilter(resolved, picked?.id, presets);
        update("collisionPreset", picked ? picked.id : CUSTOM_COLLISION_PRESET, { ...values });
      },
    },
    collisionLayerRow(actorId, component, update, context.collisionLayers, resolved.layer, Boolean(preset)),
    {
      kind: "collision-responses",
      id: rowId(actorId, component.id, "responses"),
      label: "Collision Responses",
      value: { mask: resolved.mask, overlapMask: resolved.overlapMask },
      labels: names,
      disabled: Boolean(preset),
      onChange: (next) => update("mask", next.mask, { overlapMask: next.overlapMask }),
    },
  ];
}
