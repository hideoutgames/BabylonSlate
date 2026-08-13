import type { BindingModifiers, InputDevice } from "@babylonslate/input";
import { humanizePropertyLabel } from "./humanize-property-label";

const KEY_NAMES: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "Backspace",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  ControlLeft: "Left Ctrl",
  ControlRight: "Right Ctrl",
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  MetaLeft: "Left Meta",
  MetaRight: "Right Meta",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

const MOUSE_BUTTON_NAMES = ["Mouse Left", "Mouse Middle", "Mouse Right"];

const GAMEPAD_BUTTON_NAMES = [
  "A",
  "B",
  "X",
  "Y",
  "LB",
  "RB",
  "LT",
  "RT",
  "Back",
  "Start",
  "Left Stick",
  "Right Stick",
  "D-Pad Up",
  "D-Pad Down",
  "D-Pad Left",
  "D-Pad Right",
];

const GAMEPAD_AXIS_NAMES = [
  "Left Stick X",
  "Left Stick Y",
  "Right Stick X",
  "Right Stick Y",
];

const TOUCH_NAMES: Record<string, string> = {
  "joystick-x": "Joystick X",
  "joystick-y": "Joystick Y",
  "dpad-x": "D-Pad X",
  "dpad-y": "D-Pad Y",
};

function formatKeyCode(code: string): string {
  if (code.startsWith("Key") && code.length === 4) return code.slice(3);
  if (code.startsWith("Digit") && code.length === 6) return code.slice(5);
  return KEY_NAMES[code] ?? code;
}

function parsePadCode(code: string): [number, number] {
  const [padRaw, indexRaw] = code.split(":");
  return [Number(padRaw) || 0, Number(indexRaw) || 0];
}

function modifierPrefix(modifiers?: BindingModifiers): string {
  if (!modifiers) return "";
  const parts: string[] = [];
  if (modifiers.ctrl) parts.push("Ctrl");
  if (modifiers.alt) parts.push("Alt");
  if (modifiers.shift) parts.push("Shift");
  if (modifiers.meta) parts.push("Meta");
  return parts.length > 0 ? `${parts.join("+")}+` : "";
}

/** Human label for a stored input binding (device + code + optional modifiers). */
export function formatBindingLabel(
  device: InputDevice,
  code: string,
  modifiers?: BindingModifiers,
): string {
  const prefix = modifierPrefix(modifiers);
  switch (device) {
    case "key":
      return `${prefix}${formatKeyCode(code)}`;
    case "mouseButton": {
      const index = Number(code);
      return `${prefix}${MOUSE_BUTTON_NAMES[index] ?? `Mouse ${code}`}`;
    }
    case "pointer":
      return `${prefix}${code === "primary" ? "Primary Pointer" : code}`;
    case "gamepadButton": {
      const [pad, button] = parsePadCode(code);
      const name = GAMEPAD_BUTTON_NAMES[button] ?? `Button ${button}`;
      return `${prefix}Gamepad ${pad + 1} ${name}`;
    }
    case "gamepadAxis": {
      const [pad, axis] = parsePadCode(code);
      const name = GAMEPAD_AXIS_NAMES[axis] ?? `Axis ${axis}`;
      return `${prefix}Gamepad ${pad + 1} ${name}`;
    }
    case "touch":
      return `${prefix}${TOUCH_NAMES[code] ?? humanizePropertyLabel(code)}`;
  }
}

export function modifiersFromKeyboardEvent(event: {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): BindingModifiers | undefined {
  const modifiers: BindingModifiers = {};
  if (event.shiftKey) modifiers.shift = true;
  if (event.ctrlKey) modifiers.ctrl = true;
  if (event.altKey) modifiers.alt = true;
  if (event.metaKey) modifiers.meta = true;
  return Object.keys(modifiers).length > 0 ? modifiers : undefined;
}
