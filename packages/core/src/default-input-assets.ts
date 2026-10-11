import { DEFAULT_PROJECT_INPUT_SETTINGS } from "./project";
import {
  normalizeInputAssetPayload,
  type AxisBinding,
  type InputAssetDefinition,
} from "./input-assets";

/** Each starter binding's stable id within its asset. */
function withBindingIds(bindings: readonly AxisBinding[]): AxisBinding[] {
  return bindings.map((binding, index) => ({ ...binding, id: `binding-${index + 1}` }));
}

/** Starter controls for the built-in 3D template and explicit test fixtures. */
export function createDefaultInputAssets(): Array<
  Omit<InputAssetDefinition, "guid">
> {
  return [
    ...DEFAULT_PROJECT_INPUT_SETTINGS.actions.map((action) => ({
      type: "InputAction" as const,
      name: action.name,
      ...normalizeInputAssetPayload("InputAction", {
        bindings: withBindingIds(action.bindings),
      }),
    })),
    ...DEFAULT_PROJECT_INPUT_SETTINGS.axes.map((axis) => ({
      type: "InputAxis" as const,
      name: axis.name,
      ...normalizeInputAssetPayload("InputAxis", {
        valueType: axis.kind === "2d" ? "2d" : "1d",
        bindings: withBindingIds(axis.bindings),
      }),
    })),
  ];
}
