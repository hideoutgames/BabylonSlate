/**
 * Bindable device codes for input asset and native Input Control pickers.
 * Labels are the same strings the editor shows on a closed binding.
 */

import {
  INPUT_KEYS,
  INPUT_GAMEPAD_BUTTON_NAMES as GAMEPAD_BUTTON_NAMES,
  INPUT_GAMEPAD_AXIS_NAMES as GAMEPAD_AXIS_NAMES,
} from "@babylonslate/core";
import type { InputDevice } from "./mappings";

export interface BindingCatalogEntry {
  code: string;
  label: string;
  group: string;
}

const GAMEPAD_PAD_COUNT = 4;

const TOUCH_LABELS: Record<string, string> = {
  "joystick-x": "Joystick X",
  "joystick-y": "Joystick Y",
  "dpad-x": "D-Pad X",
  "dpad-y": "D-Pad Y",
  Jump: "Jump",
};

const KEYBOARD_CATALOG: BindingCatalogEntry[] = INPUT_KEYS.filter(
  (entry) => entry.device === "key" && entry.key !== "None",
).map(({ code, label, group }) => ({ code, label, group }));
const MOUSE_CATALOG: BindingCatalogEntry[] = INPUT_KEYS.filter(
  (entry) => entry.device === "mouseButton",
).map(({ code, label, group }) => ({ code, label, group }));

const POINTER_CATALOG: BindingCatalogEntry[] = [
  { code: "primary", label: "Primary Pointer", group: "Pointer" },
];

function padGroup(padIndex: number): string {
  return `Gamepad ${padIndex + 1}`;
}

function padLabel(padIndex: number, name: string): string {
  return `${padGroup(padIndex)} ${name}`;
}

function gamepadButtonCatalog(): BindingCatalogEntry[] {
  const entries: BindingCatalogEntry[] = [];
  for (let pad = 0; pad < GAMEPAD_PAD_COUNT; pad += 1) {
    GAMEPAD_BUTTON_NAMES.forEach((name, button) => {
      entries.push({
        code: `${pad}:${button}`,
        label: name,
        group: padGroup(pad),
      });
    });
  }
  return entries;
}

function gamepadAxisCatalog(): BindingCatalogEntry[] {
  const entries: BindingCatalogEntry[] = [];
  for (let pad = 0; pad < GAMEPAD_PAD_COUNT; pad += 1) {
    GAMEPAD_AXIS_NAMES.forEach((name, axis) => {
      entries.push({
        code: `${pad}:${axis}`,
        label: name,
        group: padGroup(pad),
      });
    });
  }
  return entries;
}

const GAMEPAD_BUTTON_CATALOG = gamepadButtonCatalog();
const GAMEPAD_AXIS_CATALOG = gamepadAxisCatalog();

const CATALOG_BY_DEVICE: Record<InputDevice, BindingCatalogEntry[]> = {
  key: KEYBOARD_CATALOG,
  mouseButton: MOUSE_CATALOG,
  pointer: POINTER_CATALOG,
  gamepadButton: GAMEPAD_BUTTON_CATALOG,
  gamepadAxis: GAMEPAD_AXIS_CATALOG,
  touch: Object.entries(TOUCH_LABELS).map(([code, label]) => ({
    code,
    label,
    group: "Touch",
  })),
};

function catalogLookup(): Map<string, BindingCatalogEntry> {
  const map = new Map<string, BindingCatalogEntry>();
  for (const [device, entries] of Object.entries(CATALOG_BY_DEVICE) as Array<
    [InputDevice, BindingCatalogEntry[]]
  >) {
    for (const entry of entries) {
      map.set(`${device}:${entry.code}`, entry);
    }
  }
  return map;
}

const CATALOG_LOOKUP = catalogLookup();

function parsePadCode(code: string): [number, number] {
  const [padRaw, indexRaw] = code.split(":");
  return [Number(padRaw) || 0, Number(indexRaw) || 0];
}

function titleCaseId(code: string): string {
  return code
    .split(/[-_/\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function fallbackKeyLabel(code: string): string {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return code;
}

/** Codes the Input picker lists for a device. Editors may add custom touch ids. */
export function bindingCodesForDevice(
  device: InputDevice,
): BindingCatalogEntry[] {
  return CATALOG_BY_DEVICE[device];
}

/** Human label for a stored device code, with fallbacks for unknown codes. */
export function bindingCodeLabel(device: InputDevice, code: string): string {
  const known = CATALOG_LOOKUP.get(`${device}:${code}`);
  if (known && device !== "gamepadButton" && device !== "gamepadAxis") {
    return known.label;
  }
  switch (device) {
    case "key":
      return fallbackKeyLabel(code);
    case "mouseButton":
      return `Mouse ${code}`;
    case "pointer":
      return code;
    case "gamepadButton": {
      const [pad, button] = parsePadCode(code);
      const name =
        GAMEPAD_BUTTON_NAMES[button] ?? known?.label ?? `Button ${button}`;
      return padLabel(pad, name);
    }
    case "gamepadAxis": {
      const [pad, axis] = parsePadCode(code);
      const name = GAMEPAD_AXIS_NAMES[axis] ?? known?.label ?? `Axis ${axis}`;
      return padLabel(pad, name);
    }
    case "touch":
      return TOUCH_LABELS[code] ?? titleCaseId(code);
  }
}
