/** Input asset data is shared by authoring, workers, and exported games. */
export const INPUT_ASSET_TYPES = ["InputAction", "InputAxis"] as const;
export type InputAssetType = (typeof INPUT_ASSET_TYPES)[number];
export const INPUT_DEVICES = [
  "key",
  "mouseButton",
  "pointer",
  "gamepadButton",
  "gamepadAxis",
  "touch",
] as const;
export type InputDevice = (typeof INPUT_DEVICES)[number];
export interface BindingModifiers {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}
export interface ActionBinding {
  /** Stable within its owning input asset; legacy mappings may omit it. */
  id?: string;
  device: InputDevice;
  code: string;
  modifiers?: BindingModifiers;
}
export interface AxisBinding extends ActionBinding {
  component?: "x" | "y";
  deadZone?: number;
  scale?: number;
  invert?: boolean;
  sensitivity?: number;
  digitalValue?: number;
}
export interface InputAssetPayload {
  valueType: "button" | "1d" | "2d";
  bindings: Array<AxisBinding & { id: string }>;
  /** Read-only compatibility identity for graphs made before input assets. */
  legacyName?: string;
}
export interface InputAssetDefinition extends InputAssetPayload {
  guid: string;
  name: string;
  type: InputAssetType;
}
/** Native graph structure. Asset is authoritative; Name is resolved metadata. */
export interface InputTypeValue {
  Name: string;
  Asset: string;
}
export interface InputControlValue {
  Device: InputDevice;
  Code: string;
  Shift: boolean;
  Ctrl: boolean;
  Alt: boolean;
  Meta: boolean;
}
export interface InputBindingValue {
  Label: string;
  Input: InputTypeValue;
  Id: string;
  Control: InputControlValue;
}
export interface InputValueState {
  input: InputTypeValue;
  valueType: InputAssetPayload["valueType"];
  started: boolean;
  held: boolean;
  released: boolean;
  value: boolean | number | { x: number; y: number };
  heldSeconds: number;
  lastHeldSeconds: number;
}
export function isInputAssetType(type: string): type is InputAssetType {
  return type === "InputAction" || type === "InputAxis";
}
export function createInputAssetPayload(
  type: InputAssetType,
): InputAssetPayload {
  return { valueType: type === "InputAction" ? "button" : "1d", bindings: [] };
}
export function normalizeInputAssetPayload(
  type: InputAssetType,
  value: unknown,
): InputAssetPayload {
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const used = new Set<string>();
  const bindings: InputAssetPayload["bindings"] = [];
  for (const [index, item] of (Array.isArray(source.bindings)
    ? source.bindings
    : []
  ).entries()) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (
      !(INPUT_DEVICES as readonly unknown[]).includes(row.device) ||
      typeof row.code !== "string"
    )
      continue;
    let id =
      typeof row.id === "string" && row.id.trim()
        ? row.id
        : `binding-${index + 1}`;
    while (used.has(id)) id += "-copy";
    used.add(id);
    const binding: AxisBinding & { id: string } = {
      id,
      device: row.device as InputDevice,
      code: row.code,
    };
    if (row.modifiers && typeof row.modifiers === "object") {
      const flags: BindingModifiers = {};
      for (const flag of ["shift", "ctrl", "alt", "meta"] as const) {
        if ((row.modifiers as Record<string, unknown>)[flag] === true)
          flags[flag] = true;
      }
      if (Object.keys(flags).length) binding.modifiers = flags;
    }
    if (type === "InputAxis") {
      if (row.component === "x" || row.component === "y")
        binding.component = row.component;
      for (const field of [
        "deadZone",
        "scale",
        "sensitivity",
        "digitalValue",
      ] as const) {
        if (typeof row[field] === "number" && Number.isFinite(row[field]))
          binding[field] = row[field];
      }
      if (row.invert === true) binding.invert = true;
    }
    bindings.push(binding);
  }
  return {
    valueType:
      type === "InputAction"
        ? "button"
        : source.valueType === "2d" || source.kind === "2d"
          ? "2d"
          : "1d",
    bindings,
    ...(typeof source.legacyName === "string" && source.legacyName
      ? { legacyName: source.legacyName }
      : {}),
  };
}
