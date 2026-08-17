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
