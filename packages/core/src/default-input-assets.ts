import {
  normalizeInputAssetPayload,
  type InputAssetDefinition,
} from "./input-assets";

/** Starter actions and axes of the built-in templates, before asset ids and normalization. */
const STARTER_INPUT: {
  actions: Array<{ name: string; bindings: Array<Record<string, unknown>> }>;
  axes: Array<{ name: string; kind: "1d" | "2d"; bindings: Array<Record<string, unknown>> }>;
} = {
  actions: [
    {
      name: "Jump",
      bindings: [
        { device: "key", code: "Space" },
        { device: "gamepadButton", code: "0:0" },
      ],
    },
    {
      name: "Confirm",
      bindings: [
        { device: "key", code: "Enter" },
        // Face Button Right (index 1) — Jump already owns Face Button Down (0:0).
        { device: "gamepadButton", code: "0:1" },
      ],
    },
  ],
  axes: [
    {
      name: "Move",
      kind: "2d",
      bindings: [
        { device: "key", code: "KeyA", component: "x", digitalValue: -1 },
        { device: "key", code: "KeyD", component: "x", digitalValue: 1 },
        { device: "key", code: "KeyS", component: "y", digitalValue: -1 },
        { device: "key", code: "KeyW", component: "y", digitalValue: 1 },
        { device: "gamepadAxis", code: "0:0", component: "x", deadZone: 0.15 },
        {
          device: "gamepadAxis",
          code: "0:1",
          component: "y",
          deadZone: 0.15,
          invert: true,
        },
      ],
    },
    {
      name: "Look",
      kind: "1d",
      bindings: [{ device: "gamepadAxis", code: "0:2", deadZone: 0.15 }],
    },
  ],
};

/** Each starter binding's stable id within its asset. */
function withBindingIds(
  bindings: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return bindings.map((binding, index) => ({ ...binding, id: `binding-${index + 1}` }));
}

/** Starter controls for the built-in 3D template and explicit test fixtures. */
export function createDefaultInputAssets(): Array<
  Omit<InputAssetDefinition, "guid">
> {
  return [
    ...STARTER_INPUT.actions.map((action) => ({
      type: "InputAction" as const,
      name: action.name,
      ...normalizeInputAssetPayload("InputAction", {
        bindings: withBindingIds(action.bindings),
      }),
    })),
    ...STARTER_INPUT.axes.map((axis) => ({
      type: "InputAxis" as const,
      name: axis.name,
      ...normalizeInputAssetPayload("InputAxis", {
        valueType: axis.kind === "2d" ? "2d" : "1d",
        bindings: withBindingIds(axis.bindings),
      }),
    })),
  ];
}
