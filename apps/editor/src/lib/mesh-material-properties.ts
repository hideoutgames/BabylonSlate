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
    return {
      ...component.properties,
      materialGuid: inherit ? null : value,
      materialSource: inherit ? "model" : "override",
    };
  }
  return patchComponentProperties(component.properties, property, value);
}
