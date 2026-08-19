import { useMemo } from "react";
import {
  bindingCodeLabel,
  bindingCodesForDevice,
  type InputDevice,
} from "@babylonslate/input";
import { Button } from "@babylonslate/ui/components/button";
import { formatBindingLabel } from "./format-binding-label";
import { PickerIdentity } from "./picker-identity";
import { SearchDropdown } from "./search-dropdown";
import type { SearchDialogItem } from "./search-dialog";

const DEFAULT_TOUCH_IDS = [
  "joystick-x",
  "joystick-y",
  "dpad-x",
  "dpad-y",
  "Jump",
] as const;

export type BindingCodePickerProps = {
  device: InputDevice;
  code: string;
  onChange: (code: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  touchControlIds?: readonly string[];
  "data-testid"?: string;
};

function emptyPrompt(device: InputDevice): string {
  switch (device) {
    case "key":
      return "Choose Key…";
    case "gamepadAxis":
      return "Choose Axis…";
    case "touch":
      return "Choose Control…";
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
    case "pointer":
      return "Pointer";
    case "gamepadButton":
      return "Gamepad Button";
    case "gamepadAxis":
      return "Gamepad Axis";
    case "touch":
      return "Touch Control";
  }
}

function resolveTouchIds(ids?: readonly string[]): string[] {
  if (!ids || ids.length === 0) return [...DEFAULT_TOUCH_IDS];
  return ids.includes("Jump") ? [...ids] : [...ids, "Jump"];
}

function catalogItems(
  device: InputDevice,
  touchControlIds?: readonly string[],
): SearchDialogItem[] {
  if (device === "touch") {
    return resolveTouchIds(touchControlIds).map((id) => {
      const label = bindingCodeLabel("touch", id);
      return {
        id,
        label,
        description: id === label ? undefined : id,
        group: "Touch",
      };
    });
  }
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
  onChange,
  open,
  onOpenChange,
  touchControlIds,
  "data-testid": testId = "binding-code-picker",
}: BindingCodePickerProps) {
  const items = useMemo(
    () => catalogItems(device, touchControlIds),
    [device, touchControlIds],
  );
  const label = code
    ? formatBindingLabel(device, code)
    : emptyPrompt(device);

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
        size="touch"
        className="justify-start"
        data-testid={testId}
        aria-label={pickerTitle(device)}
      >
        <PickerIdentity label={label} />
      </Button>
    </SearchDropdown>
  );
}
