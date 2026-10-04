import { FOCUS_DIRECTIONS, parseFocusTargetProperties, type SerializedComponent } from "@babylonslate/core";
import type { PropertyRow } from "@babylonslate/editor-kit";

export function focusPropertyRows(actorId: string, component: SerializedComponent,
  update: (property: string, value: unknown) => void,
  targets: readonly { value: string; label: string }[] = [],
): PropertyRow[] {
  const properties = parseFocusTargetProperties(component.properties);
  const id = (key: string) => `${actorId}-${component.id}-${key}`;
  return [
    { kind: "boolean", id: id("focusEnabled"), label: "Focus Enabled", value: properties.focusEnabled, defaultValue: true,
      description: "Participates in keyboard and gamepad navigation.", onChange: (value) => update("focusEnabled", value) },
    { kind: "boolean", id: id("focusInitial"), label: "Initial Focus", value: properties.focusInitial, defaultValue: false,
      description: "Receives focus when this layer becomes active.", onChange: (value) => update("focusInitial", value) },
    ...FOCUS_DIRECTIONS.map((direction): PropertyRow => {
      const label = direction[0]!.toUpperCase() + direction.slice(1);
      const key = `focus${label}` as "focusUp" | "focusDown" | "focusLeft" | "focusRight";
      const value = properties[key] ?? "";
      const choices = targets.filter((target) => target.value !== component.id);
      return { kind: "enum", id: id(key), label: `Focus ${label}`, value, defaultValue: "",
        description: "Automatic chooses a nearby target in this direction. An explicit unavailable target stops navigation.",
        options: [{ value: "", label: "Automatic" }, ...choices,
          ...(value && !choices.some((choice) => choice.value === value) ? [{ value, label: "Missing Target" }] : [])],
        onChange: (next) => update(key, next || null) };
    }),
  ];
}
