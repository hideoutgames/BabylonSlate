import {
  bindingCodeLabel,
  type BindingModifiers,
  type InputDevice,
} from "@babylonslate/input";

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
  return `${modifierPrefix(modifiers)}${bindingCodeLabel(device, code)}`;
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
