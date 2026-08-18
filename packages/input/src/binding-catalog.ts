/**
 * Bindable device codes for Project Settings Input pickers.
 * Labels are the same strings the editor shows on a closed binding.
 */

import type { InputDevice } from "./mappings";

export interface BindingCatalogEntry {
  code: string;
  label: string;
  group: string;
}

const GAMEPAD_PAD_COUNT = 4;

const GAMEPAD_BUTTON_NAMES = [
  "Face Button Down",
  "Face Button Right",
  "Face Button Left",
  "Face Button Up",
  "Left Bumper",
  "Right Bumper",
  "Left Trigger",
  "Right Trigger",
  "Back",
  "Start",
  "Left Stick Click",
  "Right Stick Click",
  "D-Pad Up",
  "D-Pad Down",
  "D-Pad Left",
  "D-Pad Right",
  "Home",
] as const;

const GAMEPAD_AXIS_NAMES = [
  "Left Stick X",
  "Left Stick Y",
  "Right Stick X",
  "Right Stick Y",
] as const;

const TOUCH_LABELS: Record<string, string> = {
  "joystick-x": "Joystick X",
  "joystick-y": "Joystick Y",
  "dpad-x": "D-Pad X",
  "dpad-y": "D-Pad Y",
  Jump: "Jump",
};

function letterKeys(): BindingCatalogEntry[] {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return [...letters].map((letter) => ({
    code: `Key${letter}`,
    label: letter,
    group: "Letters",
  }));
}

function digitKeys(): BindingCatalogEntry[] {
  return Array.from({ length: 10 }, (_, index) => ({
    code: `Digit${index}`,
    label: String(index),
    group: "Digits",
  }));
}

const KEYBOARD_CATALOG: BindingCatalogEntry[] = [
  ...letterKeys(),
  ...digitKeys(),
  { code: "ArrowUp", label: "Up", group: "Arrows" },
  { code: "ArrowDown", label: "Down", group: "Arrows" },
  { code: "ArrowLeft", label: "Left", group: "Arrows" },
  { code: "ArrowRight", label: "Right", group: "Arrows" },
  { code: "ShiftLeft", label: "Left Shift", group: "Modifiers" },
  { code: "ShiftRight", label: "Right Shift", group: "Modifiers" },
  { code: "ControlLeft", label: "Left Ctrl", group: "Modifiers" },
  { code: "ControlRight", label: "Right Ctrl", group: "Modifiers" },
  { code: "AltLeft", label: "Left Alt", group: "Modifiers" },
  { code: "AltRight", label: "Right Alt", group: "Modifiers" },
  { code: "MetaLeft", label: "Left Meta", group: "Modifiers" },
  { code: "MetaRight", label: "Right Meta", group: "Modifiers" },
  { code: "CapsLock", label: "Caps Lock", group: "Modifiers" },
  ...Array.from({ length: 12 }, (_, index) => ({
    code: `F${index + 1}`,
    label: `F${index + 1}`,
    group: "Function",
  })),
  { code: "Home", label: "Home", group: "Navigation" },
  { code: "End", label: "End", group: "Navigation" },
  { code: "PageUp", label: "Page Up", group: "Navigation" },
  { code: "PageDown", label: "Page Down", group: "Navigation" },
  { code: "Insert", label: "Insert", group: "Navigation" },
  { code: "Delete", label: "Delete", group: "Navigation" },
  { code: "NumLock", label: "Num Lock", group: "Numpad" },
  { code: "NumpadDivide", label: "Numpad /", group: "Numpad" },
  { code: "NumpadMultiply", label: "Numpad *", group: "Numpad" },
  { code: "NumpadSubtract", label: "Numpad -", group: "Numpad" },
  { code: "NumpadAdd", label: "Numpad +", group: "Numpad" },
  { code: "NumpadEnter", label: "Numpad Enter", group: "Numpad" },
  { code: "NumpadDecimal", label: "Numpad .", group: "Numpad" },
  ...Array.from({ length: 10 }, (_, index) => ({
    code: `Numpad${index}`,
    label: `Numpad ${index}`,
    group: "Numpad",
  })),
  { code: "Backquote", label: "`", group: "Punctuation" },
  { code: "Minus", label: "-", group: "Punctuation" },
  { code: "Equal", label: "=", group: "Punctuation" },
  { code: "BracketLeft", label: "[", group: "Punctuation" },
  { code: "BracketRight", label: "]", group: "Punctuation" },
  { code: "Backslash", label: "\\", group: "Punctuation" },
  { code: "Semicolon", label: ";", group: "Punctuation" },
  { code: "Quote", label: "'", group: "Punctuation" },
  { code: "Comma", label: ",", group: "Punctuation" },
  { code: "Period", label: ".", group: "Punctuation" },
  { code: "Slash", label: "/", group: "Punctuation" },
  { code: "IntlBackslash", label: "Intl \\", group: "Punctuation" },
  { code: "Escape", label: "Escape", group: "Other" },
  { code: "Tab", label: "Tab", group: "Other" },
  { code: "Space", label: "Space", group: "Other" },
  { code: "Enter", label: "Enter", group: "Other" },
  { code: "Backspace", label: "Backspace", group: "Other" },
  { code: "ContextMenu", label: "Context Menu", group: "Other" },
  { code: "PrintScreen", label: "Print Screen", group: "Other" },
  { code: "Pause", label: "Pause", group: "Other" },
  { code: "ScrollLock", label: "Scroll Lock", group: "Other" },
];

const MOUSE_CATALOG: BindingCatalogEntry[] = [
  { code: "0", label: "Mouse Left", group: "Mouse" },
  { code: "1", label: "Mouse Middle", group: "Mouse" },
  { code: "2", label: "Mouse Right", group: "Mouse" },
];

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
  touch: [],
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

/** Codes the Input picker lists for a device. Touch ids come from the editor. */
export function bindingCodesForDevice(
  device: InputDevice,
): BindingCatalogEntry[] {
  return CATALOG_BY_DEVICE[device];
}

/** Human label for a stored device code, with fallbacks for unknown codes. */
export function bindingCodeLabel(device: InputDevice, code: string): string {
  const known = CATALOG_LOOKUP.get(`${device}:${code}`);
  if (
    known &&
    device !== "gamepadButton" &&
    device !== "gamepadAxis"
  ) {
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
