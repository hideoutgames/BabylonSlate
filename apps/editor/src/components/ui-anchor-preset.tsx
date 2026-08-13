import { Toggle } from "@babylonslate/ui/components/toggle";
import { ANCHOR_PRESETS, type AnchorPresetId } from "@babylonslate/ui-runtime";

const GRID_ORDER: AnchorPresetId[] = [
  "top-left",
  "top-center",
  "top-right",
  "top-stretch",
  "middle-left",
  "middle-center",
  "middle-right",
  "middle-stretch",
  "bottom-left",
  "bottom-center",
  "bottom-right",
  "bottom-stretch",
  "left-stretch",
  "center-stretch",
  "right-stretch",
  "stretch-stretch",
];

export function AnchorPresetPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: AnchorPresetId | null;
  onChange: (id: AnchorPresetId) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 p-2" data-testid="ui-anchor-preset">
      <p className="text-xs font-medium text-muted-foreground">Anchor Preset</p>
      <div className="grid grid-cols-4 gap-1">
        {GRID_ORDER.map((id) => {
          const preset = ANCHOR_PRESETS.find((row) => row.id === id)!;
          return (
            <Toggle
              key={id}
              size="sm"
              pressed={value === id}
              disabled={disabled}
              aria-label={preset.label}
              data-testid={`ui-anchor-preset-${id}`}
              onPressedChange={() => onChange(id)}
            >
              <span className="truncate text-[10px]">{preset.label}</span>
            </Toggle>
          );
        })}
      </div>
    </div>
  );
}
