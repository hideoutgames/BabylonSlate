import { Button } from "@babylonslate/ui/components/button";
import { TypeColorMark } from "./type-color-mark";
import { SearchDropdown } from "./search-dropdown";
import {
  PIN_PICKER_TYPES,
  pinPickerColorVar,
  pinPickerLabel,
  type PinPickerType,
} from "./pin-types";

export type PinTypePickerProps = {
  value: PinPickerType | string;
  onChange: (type: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  types?: readonly string[];
  "data-testid"?: string;
};

/** Colored searchable type picker (Unreal pin-type dropdown). */
export function PinTypePicker({
  value,
  onChange,
  open,
  onOpenChange,
  types = PIN_PICKER_TYPES,
  "data-testid": testId = "pin-type-picker",
}: PinTypePickerProps) {
  const selected = types.includes(value) ? value : "float";
  return (
    <SearchDropdown
      open={open}
      onOpenChange={onOpenChange}
      title="Pin Type"
      items={types.map((type) => ({
        id: type,
        label: pinPickerLabel(type),
        leading: (
          <TypeColorMark colorVar={pinPickerColorVar(type)} />
        ),
      }))}
      onSelect={(id) => onChange(id)}
      placeholder="Search types"
      data-testid={`${testId}-menu`}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-[var(--chrome-row,28px)] justify-start"
        data-testid={testId}
        aria-label="Pin type"
      >
        <TypeColorMark
          colorVar={pinPickerColorVar(selected)}
          label={pinPickerLabel(selected)}
        />
      </Button>
    </SearchDropdown>
  );
}
