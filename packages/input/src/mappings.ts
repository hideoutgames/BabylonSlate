/**
 * Pure action / axis mapping model (engineplan §11). Bindings carry per-device
 * dead zone, scale, inversion and sensitivity so a gamepad stick and an
 * on-screen joystick can drive the same axis identically.
 */

export type InputDevice =
  | "key"
  | "mouseButton"
  | "pointer"
  | "gamepadButton"
  | "gamepadAxis"
  | "touch";

export interface BindingModifiers {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface ActionBinding {
  device: InputDevice;
  /**
   * Device-specific code: keyboard `KeyW`, mouse `0`, gamepad button
   * `0:0` (pad:button), pointer `primary`, touch control id.
   */
  code: string;
  modifiers?: BindingModifiers;
}

export interface AxisBinding {
  device: InputDevice;
  code: string;
  /** Component for 2D axes assembled from two 1D bindings. */
  component?: "x" | "y";
  deadZone?: number;
  scale?: number;
  invert?: boolean;
  sensitivity?: number;
  modifiers?: BindingModifiers;
  /** Constant contribution while a digital binding is held (keys, buttons). */
  digitalValue?: number;
}

export interface ActionMapping {
  name: string;
  bindings: ActionBinding[];
}

export interface AxisMapping {
  name: string;
  /** `2d` folds x/y bindings into one `getAxis2D` result. */
  kind?: "1d" | "2d";
  bindings: AxisBinding[];
}

export interface InputMappings {
  actions: ActionMapping[];
  axes: AxisMapping[];
}

export const DEFAULT_INPUT_MAPPINGS: InputMappings = {
  actions: [
    {
      name: "Jump",
      bindings: [
        { device: "key", code: "Space" },
        { device: "gamepadButton", code: "0:0" },
        { device: "touch", code: "Jump" },
      ],
    },
    {
      name: "Confirm",
      bindings: [
        { device: "key", code: "Enter" },
        // Face button B (index 1) — Jump already owns A (0:0).
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
        {
          device: "gamepadAxis",
          code: "0:0",
          component: "x",
          deadZone: 0.15,
        },
        {
          device: "gamepadAxis",
          code: "0:1",
          component: "y",
          deadZone: 0.15,
          invert: true,
        },
        {
          device: "touch",
          code: "joystick-x",
          component: "x",
          deadZone: 0.15,
        },
        {
          device: "touch",
          code: "joystick-y",
          component: "y",
          deadZone: 0.15,
        },
        {
          device: "touch",
          code: "dpad-x",
          component: "x",
          deadZone: 0.15,
        },
        {
          device: "touch",
          code: "dpad-y",
          component: "y",
          deadZone: 0.15,
        },
      ],
    },
    {
      name: "Look",
      kind: "1d",
      bindings: [
        { device: "gamepadAxis", code: "0:2", deadZone: 0.15 },
      ],
    },
  ],
};

export function createDefaultInputMappings(): InputMappings {
  return structuredClone(DEFAULT_INPUT_MAPPINGS);
}

function asDevice(value: unknown): InputDevice | null {
  switch (value) {
    case "key":
    case "mouseButton":
    case "pointer":
    case "gamepadButton":
    case "gamepadAxis":
    case "touch":
      return value;
    default:
      return null;
  }
}

function normalizeActionBinding(value: unknown): ActionBinding | null {
  const source = (value ?? {}) as Record<string, unknown>;
  const device = asDevice(source.device);
  if (!device || typeof source.code !== "string" || source.code === "") {
    return null;
  }
  const modifiers = source.modifiers as BindingModifiers | undefined;
  return {
    device,
    code: source.code,
    ...(modifiers ? { modifiers: { ...modifiers } } : {}),
  };
}

function normalizeAxisBinding(value: unknown): AxisBinding | null {
  const source = (value ?? {}) as Record<string, unknown>;
  const device = asDevice(source.device);
  if (!device || typeof source.code !== "string" || source.code === "") {
    return null;
  }
  const binding: AxisBinding = { device, code: source.code };
  if (source.component === "x" || source.component === "y") {
    binding.component = source.component;
  }
  if (typeof source.deadZone === "number") binding.deadZone = source.deadZone;
  if (typeof source.scale === "number") binding.scale = source.scale;
  if (source.invert === true) binding.invert = true;
  if (typeof source.sensitivity === "number") {
    binding.sensitivity = source.sensitivity;
  }
  if (typeof source.digitalValue === "number") {
    binding.digitalValue = source.digitalValue;
  }
  const modifiers = source.modifiers as BindingModifiers | undefined;
  if (modifiers) binding.modifiers = { ...modifiers };
  return binding;
}

/** Coerce an unknown project.json payload into a valid mapping document. */
export function normalizeInputMappings(value: unknown): InputMappings {
  const source = (value ?? {}) as Record<string, unknown>;
  const actions: ActionMapping[] = [];
  if (Array.isArray(source.actions)) {
    for (const entry of source.actions) {
      const row = (entry ?? {}) as Record<string, unknown>;
      if (typeof row.name !== "string" || row.name.trim() === "") continue;
      const bindings = Array.isArray(row.bindings)
        ? row.bindings
            .map(normalizeActionBinding)
            .filter((binding): binding is ActionBinding => binding !== null)
        : [];
      actions.push({ name: row.name.trim(), bindings });
    }
  }
  const axes: AxisMapping[] = [];
  if (Array.isArray(source.axes)) {
    for (const entry of source.axes) {
      const row = (entry ?? {}) as Record<string, unknown>;
      if (typeof row.name !== "string" || row.name.trim() === "") continue;
      const bindings = Array.isArray(row.bindings)
        ? row.bindings
            .map(normalizeAxisBinding)
            .filter((binding): binding is AxisBinding => binding !== null)
        : [];
      axes.push({
        name: row.name.trim(),
        kind: row.kind === "2d" ? "2d" : "1d",
        bindings,
      });
    }
  }
  if (actions.length === 0 && axes.length === 0) {
    return createDefaultInputMappings();
  }
  return { actions, axes };
}
