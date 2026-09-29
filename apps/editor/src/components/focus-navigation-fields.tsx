import { useState } from "react";
import { normalizeFocusNavigationSettings, type FocusNavigationSettings } from "@babylonslate/core";
import { AssetPicker, PropertyGrid, type PropertyRow } from "@babylonslate/editor-kit";
import { FieldGroup, FieldSet, FieldLegend } from "@babylonslate/ui/components/field";

export function FocusNavigationFields({ value, onChange, assets }: {
  value: FocusNavigationSettings | undefined;
  onChange(value: FocusNavigationSettings): void;
  assets: Array<{ guid: string; name: string; type: string; path: string; valueType?: unknown }>;
}) {
  const settings = normalizeFocusNavigationSettings(value);
  const [picker, setPicker] = useState<"navigationInputGuid" | "activateInputGuid" | null>(null);
  const patch = (next: Partial<FocusNavigationSettings>) => onChange({ ...settings, ...next });
  const rows: PropertyRow[] = [
    { kind: "boolean", id: "settings-focus-enabled", label: "Focus Navigation", value: settings.enabled,
      onChange: (enabled) => patch({ enabled }), description: "Keyboard and gamepad focus for SceneLayer elements." },
    ...([ ["navigationInputGuid", "Navigation Input", "InputAxis"], ["activateInputGuid", "Activate Input", "InputAction"] ] as const).map(([key, label, type]): PropertyRow => ({
      kind: "asset", id: `settings-focus-${key}`, label, value: settings[key], disabled: !settings.enabled,
      displayLabel: assets.find((asset) => asset.guid === settings[key])?.name, displayType: type,
      placeholder: "Built-In Controls", onPick: () => setPicker(key), onChange: (guid) => patch({ [key]: guid }),
      description: key === "navigationInputGuid" ? "2D Input Axis; None uses arrows, WASD, D-Pad and left stick. Positive Y moves up."
        : "Input Action; None uses Enter, Space and the bottom gamepad face button. Bindings can be rebound in game.",
    })),
    { kind: "number", id: "settings-focus-repeat-delay", label: "Repeat Delay", value: settings.repeatDelay, min: 0, max: 10, sensitivity: 0.05, unit: "s", disabled: !settings.enabled,
      onChange: (repeatDelay) => patch({ repeatDelay }) },
    { kind: "number", id: "settings-focus-repeat-interval", label: "Repeat Interval", value: settings.repeatInterval, min: 0.02, max: 10, sensitivity: 0.01, unit: "s", disabled: !settings.enabled,
      onChange: (repeatInterval) => patch({ repeatInterval }) },
    { kind: "boolean", id: "settings-focus-wrap", label: "Wrap Navigation", value: settings.wrap, disabled: !settings.enabled,
      onChange: (wrap) => patch({ wrap }) },
  ];
  return <>
    <FieldGroup><FieldSet><FieldLegend>Focus Navigation</FieldLegend><PropertyGrid rows={rows} /></FieldSet></FieldGroup>
    <AssetPicker open={picker !== null} onOpenChange={(open) => { if (!open) setPicker(null); }}
      title={picker === "navigationInputGuid" ? "Pick Navigation Input" : "Pick Activate Input"}
      allowedTypes={picker === "navigationInputGuid" ? ["InputAxis"] : ["InputAction"]} allowNone
      assets={assets.filter((asset) => picker === "navigationInputGuid" ? asset.type === "InputAxis" && asset.valueType === "2d" : asset.type === "InputAction")}
      onPick={(guid) => { if (picker) patch({ [picker]: guid }); setPicker(null); }} />
  </>;
}
