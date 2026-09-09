import type { InputAssetDefinition } from "@babylonslate/core";
import { normalizeInputMappings, type InputMappings } from "./mappings";

/** An explicit empty catalog means no inputs; it must never restore defaults. */
export function inputMappingsFromAssets(
  assets: readonly InputAssetDefinition[],
): InputMappings {
  return normalizeInputMappings({
    actions: assets
      .filter((asset) => asset.type === "InputAction")
      .map((asset) => ({
        id: asset.guid,
        name: asset.name,
        bindings: asset.bindings,
      })),
    axes: assets
      .filter((asset) => asset.type === "InputAxis")
      .map((asset) => ({
        id: asset.guid,
        name: asset.name,
        kind: asset.valueType === "2d" ? "2d" : "1d",
        bindings: asset.bindings,
      })),
  });
}
export function inputMappingKey(mapping: {
  id?: string;
  name: string;
}): string {
  return mapping.id || mapping.name;
}
