/**
 * Pure action / axis mapping model (engineplan §11). Bindings carry per-device
 * dead zone, scale, inversion and sensitivity so a gamepad stick and an
 * on-screen joystick can drive the same axis identically.
 */

import type {
  InputDevice,
  BindingModifiers,
  ActionBinding,
  AxisBinding,
} from "@babylonslate/core";
export type {
  InputDevice,
  BindingModifiers,
  ActionBinding,
  AxisBinding,
} from "@babylonslate/core";

export interface ActionMapping {
  id?: string;
  name: string;
  bindings: ActionBinding[];
}

export interface AxisMapping {
  id?: string;
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
      ],
    },
    {
      name: "Look",
      kind: "1d",
      bindings: [{ device: "gamepadAxis", code: "0:2", deadZone: 0.15 }],
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

function normalizeActionBinding(
  value: unknown,
  allowIncomplete: boolean,
): ActionBinding | null {
  const source = (value ?? {}) as Record<string, unknown>;
  const device = asDevice(source.device);
  if (!device || typeof source.code !== "string") return null;
  if (source.code === "" && !allowIncomplete) return null;
  const modifiers = source.modifiers as BindingModifiers | undefined;
  return {
    device,
    ...(typeof source.id === "string" ? { id: source.id } : {}),
    code: source.code,
    ...(modifiers ? { modifiers: { ...modifiers } } : {}),
  };
}

function normalizeAxisBinding(
  value: unknown,
  allowIncomplete: boolean,
): AxisBinding | null {
  const source = (value ?? {}) as Record<string, unknown>;
  const device = asDevice(source.device);
  if (!device || typeof source.code !== "string") return null;
  if (source.code === "" && !allowIncomplete) return null;
  const binding: AxisBinding = { device, code: source.code };
  if (typeof source.id === "string") binding.id = source.id;
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

export interface NormalizeInputMappingsOptions {
  /** Keep `{ device, code: "" }` drafts for Project Settings authoring. */
  allowIncomplete?: boolean;
}

/** Coerce an unknown project.json payload into a valid mapping document. */
export function normalizeInputMappings(
  value: unknown,
  options?: NormalizeInputMappingsOptions,
): InputMappings {
  const allowIncomplete = options?.allowIncomplete === true;
  const source = (value ?? {}) as Record<string, unknown>;
  const actions: ActionMapping[] = [];
  if (Array.isArray(source.actions)) {
    for (const entry of source.actions) {
      const row = (entry ?? {}) as Record<string, unknown>;
      if (typeof row.name !== "string" || row.name.trim() === "") continue;
      const bindings = Array.isArray(row.bindings)
        ? row.bindings
            .map((binding) => normalizeActionBinding(binding, allowIncomplete))
            .filter((binding): binding is ActionBinding => binding !== null)
        : [];
      actions.push({
        name: row.name.trim(),
        ...mappingIdentity(row),
        bindings,
      });
    }
  }
  const axes: AxisMapping[] = [];
  if (Array.isArray(source.axes)) {
    for (const entry of source.axes) {
      const row = (entry ?? {}) as Record<string, unknown>;
      if (typeof row.name !== "string" || row.name.trim() === "") continue;
      const bindings = Array.isArray(row.bindings)
        ? row.bindings
            .map((binding) => normalizeAxisBinding(binding, allowIncomplete))
            .filter((binding): binding is AxisBinding => binding !== null)
        : [];
      axes.push({
        name: row.name.trim(),
        ...mappingIdentity(row),
        kind: row.kind === "2d" ? "2d" : "1d",
        bindings,
      });
    }
  }
  if (!Array.isArray(source.actions) && !Array.isArray(source.axes)) {
    return createDefaultInputMappings();
  }
  return { actions, axes };
}

function mappingIdentity(row: Record<string, unknown>): {
  id?: string;
} {
  return {
    ...(typeof row.id === "string" && row.id ? { id: row.id } : {}),
  };
}
