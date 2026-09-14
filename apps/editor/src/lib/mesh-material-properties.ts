import { patchComponentProperties, type SerializedComponent } from "@babylonslate/core";

/** Picker-only value; persisted components store a source and an optional guid. */
export const MODEL_MATERIALS_PICKER_VALUE = "__model_materials__";

export const MODEL_MATERIALS_PICKER_ENTRY = {
  guid: MODEL_MATERIALS_PICKER_VALUE,
  name: "Model Materials",
  type: "Material",
};

export function patchInspectorComponentProperty(
  component: SerializedComponent,
  property: string,
  value: unknown,
): Record<string, unknown> {
  if (component.classId === "MeshComponent" && property === "materialGuid") {
    const inherit = value === MODEL_MATERIALS_PICKER_VALUE;
    const properties: Record<string, unknown> = {
      ...component.properties,
      materialGuid: inherit ? null : value,
    };
    // Only None needs a marker. Removing redundant source keys lets prefab
    // resets resume inheriting subsequent changes to the prefab's material.
    if (!inherit && !value) properties.materialSource = "override";
    else delete properties.materialSource;
    return properties;
  }
  return patchComponentProperties(component.properties, property, value);
}
