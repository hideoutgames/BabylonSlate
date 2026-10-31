import { parseMeshCollisionMode } from "@haptic/assets";
import type { SerializedComponent } from "@haptic/core";
import { assetRowIdentity, type PropertyRow } from "@haptic/editor-kit";
import { cablePropertyRows } from "./cable-property-rows";
import { collisionRows } from "./collision-property-rows";
import {
  assetRow,
  genericRows,
  guidValue,
  rowId,
  type ComponentPropertyContext,
  type ComponentPropertyUpdate,
} from "./component-property-row-helpers";
import { MODEL_MATERIALS_PICKER_VALUE } from "./mesh-material-properties";

const MESH_KINDS = ["box", "sphere", "cylinder", "plane", "ground"];

function meshCollisionRows(
  actorId: string,
  component: SerializedComponent,
  update: (property: string, value: unknown) => void,
  context: ComponentPropertyContext,
): PropertyRow[] {
  if (context.physicsWorld !== "3d") return [];
  const mode = parseMeshCollisionMode(component.properties.collisionMode);
  const rows: PropertyRow[] = [
    {
      kind: "enum",
      id: rowId(actorId, component.id, "collisionMode"),
      label: "Collision",
      value: mode,
      options: [
        { value: "simple", label: "Use Simple Collision" },
        { value: "complex", label: "Use Complex Collision" },
        { value: "none", label: "No Collision" },
      ],
      onChange: (next) => update("collisionMode", next),
    },
  ];
  if (mode === "none") return rows;
  rows.push(
    ...collisionRows(actorId, component, update, context),
  );
  return rows;
}

export function meshPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  const assetGuid =
    typeof component.properties.assetGuid === "string"
      ? component.properties.assetGuid.trim()
      : "";
  const meshKindRow: PropertyRow[] = assetGuid
    ? []
    : [
        {
          kind: "enum",
          id: rowId(actorId, component.id, "meshKind"),
          label: "Mesh Kind",
          value: String(component.properties.meshKind ?? "box"),
          options: MESH_KINDS.map((kind) => ({ value: kind, label: kind })),
          onChange: (next) => update("meshKind", next),
        },
      ];
  const materialRow = assetRow(
    actorId,
    component,
    "materialGuid",
    "Material",
    ["Material", "MaterialInstance"],
    update,
    context,
    "Pick Material",
  );
  if (assetGuid && materialRow.kind === "asset") {
    materialRow.defaultValue = MODEL_MATERIALS_PICKER_VALUE;
    if (
      !guidValue(component.properties.materialGuid) &&
      component.properties.materialSource !== "override"
    ) {
      const slots = context.modelMaterialSlots?.(assetGuid) ?? [];
      const slot = slots.length === 1 ? slots[0] : undefined;
      const name = slot?.materialGuid
        ? context.assetLabel(slot.materialGuid) ?? slot.name
        : slot?.name;
      Object.assign(materialRow, assetRowIdentity({
        name: name || "Model Materials",
        type: "Material",
      }));
      materialRow.value = MODEL_MATERIALS_PICKER_VALUE;
    }
  }
  return [
    ...meshKindRow,
    assetRow(
      actorId,
      component,
      "assetGuid",
      "Asset",
      ["Model"],
      update,
      context,
      "Pick Mesh",
    ),
    materialRow,
    ...meshCollisionRows(actorId, component, update, context),
    ...(["castShadows", "receiveShadows"] as const).map((key) => ({
      kind: "boolean" as const,
      id: rowId(actorId, component.id, key),
      label: key === "castShadows" ? "Cast Shadows" : "Receive Shadows",
      value: component.properties[key] !== false,
      onChange: (value: boolean) => update(key, value),
    })),
    {
      kind: "enum",
      id: rowId(actorId, component.id, "occluder"),
      label: "Occluder",
      value: component.properties.occluder === "always" || component.properties.occluder === "never" ? component.properties.occluder : "auto",
      defaultValue: "auto",
      options: [
        { value: "auto", label: "Auto" },
        { value: "always", label: "Always" },
        { value: "never", label: "Never" },
      ],
      description: "With Occlusion Culling on, whether this mesh hides what is behind it. Auto: when solid and large enough on screen.",
      onChange: (next) => update("occluder", next),
    },
    ...genericRows(
      actorId,
      component,
      update,
      new Set([
        "meshKind",
        "castShadows",
        "receiveShadows",
        "occluder",
        "assetGuid",
        "materialGuid",
        "materialSource",
        "collisionMode",
        "collisionPreset",
        "layer",
        "mask",
        "overlapMask",
      ]),
    ),
  ];
}

export function dynamicRuntimeMeshPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return [
    assetRow(actorId, component, "materialGuid", "Material", ["Material", "MaterialInstance"], update, context, "Choose Mesh Material"),
    {
      kind: "boolean", id: rowId(actorId, component.id, "enableCollision"), label: "Enable Collision",
      value: component.properties.enableCollision === true, defaultValue: false,
      disabled: context.physicsWorld !== "3d",
      description: "Use the runtime triangles for collision. Geometry edits rebuild collision on the next physics step.",
      onChange: (value) => update("enableCollision", value),
    },
    ...collisionRows(actorId, component, update, context),
    ...(["castShadows", "receiveShadows"] as const).map((key): PropertyRow => ({
      kind: "boolean", id: rowId(actorId, component.id, key),
      label: key === "castShadows" ? "Cast Shadows" : "Receive Shadows",
      value: component.properties[key] !== false, defaultValue: true,
      onChange: (value) => update(key, value),
    })),
  ];
}

export function cableComponentPropertyRows(
  actorId: string,
  component: SerializedComponent,
  update: ComponentPropertyUpdate,
  context: ComponentPropertyContext,
): PropertyRow[] {
  return [
    ...cablePropertyRows(actorId, component, update, context),
    assetRow(actorId, component, "materialGuid", "Material", ["Material", "MaterialInstance"], update, context, "Choose Cable Material"),
  ];
}
