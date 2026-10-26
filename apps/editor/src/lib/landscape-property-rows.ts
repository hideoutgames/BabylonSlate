import { parseLandscapeProperties, resizeLandscape, type LandscapeProperties, type SerializedComponent } from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import { assetRow, rowId, type ComponentPropertyContext, type ComponentPropertyUpdate } from "./component-property-row-helpers";

function formatUnits(value: number) {
  return String(Number(value.toFixed(2)));
}

/** The Cells row's note, shared with the Landscape panel. */
export function landscapeCellSizeDescription(data: LandscapeProperties): string {
  return `${formatUnits(data.width / data.subdivisions)} × ${formatUnits(data.depth / data.subdivisions)} units per cell`;
}

/**
 * The Landscape settings the Landscape panel also edits. Heights and paint
 * weights are per-vertex data that only the sculpt and paint brushes write, so
 * they have no rows.
 */
export function landscapePropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const data = parseLandscapeProperties(component.properties);
  return [
    { kind: "vector3", id: rowId(actorId, component.id, "size"), label: "Size", axes: ["W", "D"], value: [data.width, data.depth, 0], onChange: ([width, depth]) => update("width", Math.min(4096, Math.max(1, width)), { depth: Math.min(4096, Math.max(1, depth)) }) },
    {
      kind: "number", id: rowId(actorId, component.id, "subdivisions"), label: "Cells", value: data.subdivisions, min: 4, max: 256, sensitivity: 1, description: landscapeCellSizeDescription(data),
      // Resampling keeps the sculpted shape and paint at the new resolution.
      onChange: (value) => {
        const resized = resizeLandscape(data, value);
        update("subdivisions", resized.subdivisions, { heights: resized.heights, weights: resized.weights });
      },
    },
    { kind: "boolean", id: rowId(actorId, component.id, "collisionsEnabled"), label: "Landscape Collisions", value: data.collisionsEnabled, onChange: (value) => update("collisionsEnabled", value) },
    assetRow(actorId, component, "materialGuid", "Landscape Material", ["Material", "MaterialInstance"], update, context, "Landscape Material", "Default", "landscape"),
  ];
}

/** Foliage instances are painted with the Foliage brush and its group is chosen in the Foliage panels, so Details shows no raw fields. */
export function foliagePropertyRows(): PropertyRow[] {
  return [];
}
