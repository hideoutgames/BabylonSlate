import { ArrayProperty } from "@babylonslate/editor-kit";
import { TEXT2D_APPEAR_MODES, TEXT2D_APPEAR_MODE_LABELS, type Text2DAppearMode } from "@babylonslate/core";

/** Shared Scene/Prefab constraint on the reusable array property. */
export function RichTextAppearModesField({ value, onChange, defaultValue = [], "data-testid": testId }: {
  value: readonly Text2DAppearMode[];
  defaultValue?: readonly Text2DAppearMode[];
  onChange: (modes: Text2DAppearMode[]) => void;
  "data-testid"?: string;
}) {
  return <div className="p-2">
    <ArrayProperty
      label="Appear Modes" itemLabel="Mode" addLabel="Add Mode"
      value={value} onChange={(next) => onChange(next.includes("instant") ? ["instant"] : next)}
      options={TEXT2D_APPEAR_MODES.map((mode) => ({ id: mode, value: mode, label: TEXT2D_APPEAR_MODE_LABELS[mode] }))}
      unique maxItems={value.includes("instant") ? 1 : 3} defaultValue={defaultValue} emptyLabel="Off"
      description="Combine Fade, Scale, and Slide once each. Instant replaces the other modes. An empty array disables appearing."
      data-testid={testId ?? "rich-text-appear-modes"}
    />
  </div>;
}
