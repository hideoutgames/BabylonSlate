import { useMemo } from "react";
import { bindingCodesForDevice, type InputDevice } from "@babylonslate/input";
import { Button } from "@babylonslate/ui/components/button";
import { formatBindingLabel } from "./format-binding-label";
import { PickerIdentity } from "./picker-identity";
import { SearchDropdown } from "./search-dropdown";
import type { SearchDialogItem } from "./search-dialog";

export type BindingCodePickerProps = {
  device: InputDevice;
  code: string;
  size?: "sm" | "touch";
  onChange: (code: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  "data-testid"?: string;
};

function emptyPrompt(device: InputDevice): string {
  switch (device) {
    case "key":
      return "Choose Key…";
    case "gamepadAxis":
      return "Choose Axis…";
    default:
      return "Choose Button…";
  }
}

function pickerTitle(device: InputDevice): string {
  switch (device) {
    case "key":
      return "Key";
    case "mouseButton":
      return "Mouse Button";
    case "gamepadButton":
      return "Gamepad Button";
    case "gamepadAxis":
      return "Gamepad Axis";
    default:
      return "Input";
  }
}

function catalogItems(device: InputDevice): SearchDialogItem[] {
  if (device === "pointer" || device === "touch") return [];
  return bindingCodesForDevice(device).map((entry) => ({
    id: entry.code,
    label: entry.label,
    description: entry.code === entry.label ? undefined : entry.code,
    group: entry.group,
  }));
}

/** Searchable catalog of bindable codes for one input device. */
export function BindingCodePicker({
  device,
  code,
  size = "touch",
  onChange,
  open,
  onOpenChange,
  "data-testid": testId = "binding-code-picker",
}: BindingCodePickerProps) {
  const items = useMemo(() => catalogItems(device), [device]);
  const label = code ? formatBindingLabel(device, code) : emptyPrompt(device);

  return (
    <SearchDropdown
      modal
      open={open}
      onOpenChange={onOpenChange}
      title={pickerTitle(device)}
      items={items}
      onSelect={onChange}
      placeholder="Search"
      data-testid={`${testId}-menu`}
    >
      <Button
        type="button"
        variant="outline"
        size={size}
        className="justify-start"
        id={testId}
        data-testid={testId}
        aria-label={pickerTitle(device)}
      >
        <PickerIdentity label={label} />
      </Button>
    </SearchDropdown>
  );
}
