import { DEFAULT_PROJECT_INPUT_SETTINGS } from "./project";
import {
  normalizeInputAssetPayload,
  type InputAssetDefinition,
} from "./input-assets";

/** Authored controls seeded only when creating a new project. */
export function createDefaultInputAssets(): Array<
  Omit<InputAssetDefinition, "guid">
> {
  return [
    ...DEFAULT_PROJECT_INPUT_SETTINGS.actions.map((action) => ({
      type: "InputAction" as const,
      name: action.name,
      ...normalizeInputAssetPayload("InputAction", {
        bindings: action.bindings,
      }),
    })),
    ...DEFAULT_PROJECT_INPUT_SETTINGS.axes.map((axis) => ({
      type: "InputAxis" as const,
      name: axis.name,
      ...normalizeInputAssetPayload("InputAxis", {
        valueType: axis.kind === "2d" ? "2d" : "1d",
        bindings: axis.bindings,
      }),
    })),
  ];
}
