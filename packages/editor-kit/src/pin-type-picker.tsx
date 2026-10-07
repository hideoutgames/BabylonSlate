import type { ReactElement } from "react";
import { Button } from "@babylonslate/ui/components/button";
import { cn } from "@babylonslate/ui/lib/utils";
import { TypeColorMark } from "./type-color-mark";
import { SearchDropdown } from "./search-dropdown";
import {
  PIN_PICKER_TYPES,
  pinPickerColorVar,
  pinPickerLabel,
  type PinPickerType,
} from "./pin-types";

export type PinTypeMenuProps = {
  onSelect: (type: PinPickerType) => void;
  children: ReactElement;
  title?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  types?: readonly string[];
  /** Contextual names for generic value shapes (for example Data Definition). */
  labels?: Readonly<Record<string, string>>;
  "data-testid"?: string;
};

/** Searchable, colored pin-type popup anchored to any trigger (type pickers, Add Variable / Add Field). */
export function PinTypeMenu({
  onSelect,
  children,
  title = "Pin Type",
  open,
  onOpenChange,
  types = PIN_PICKER_TYPES,
  labels,
  "data-testid": testId,
}: PinTypeMenuProps) {
  return (
    <SearchDropdown
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      items={types.map((type) => ({
        id: type,
        label: labels?.[type] ?? pinPickerLabel(type),
        leading: <TypeColorMark colorVar={pinPickerColorVar(type)} />,
      }))}
      onSelect={(id) => onSelect(id as PinPickerType)}
      placeholder="Search types"
      data-testid={testId}
    >
      {children}
    </SearchDropdown>
  );
}

export type PinTypePickerProps = {
  value: PinPickerType | string;
  onChange: (type: PinPickerType) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  types?: readonly string[];
  /** Contextual names for generic value shapes (for example Data Definition). */
  labels?: Readonly<Record<string, string>>;
  /** Borderless row trigger for dense lists; the default is an outline button. */
  compact?: boolean;
  disabled?: boolean;
  "data-testid"?: string;
};

/** Colored searchable type picker (Unreal pin-type dropdown). */
export function PinTypePicker({
  value,
  onChange,
  open,
  onOpenChange,
  types = PIN_PICKER_TYPES,
  labels,
  compact = false,
  disabled = false,
  "data-testid": testId = "pin-type-picker",
}: PinTypePickerProps) {
  const selected = types.includes(value) ? value : "float";
  return (
    <PinTypeMenu
      open={open}
      onOpenChange={onOpenChange}
      types={types}
      labels={labels}
      onSelect={onChange}
      data-testid={`${testId}-menu`}
    >
      <Button
        type="button"
        variant={compact ? "ghost" : "outline"}
        size={compact ? "xs" : "sm"}
        disabled={disabled}
        className={cn(
          "justify-start",
          compact
            ? "h-6 shrink-0 px-1.5 font-normal text-muted-foreground hover:text-foreground pointer-coarse:min-h-11"
            : "min-h-[var(--chrome-row,28px)]",
        )}
        data-testid={testId}
        aria-label="Pin type"
      >
        <TypeColorMark
          colorVar={pinPickerColorVar(selected)}
          label={labels?.[selected] ?? pinPickerLabel(selected)}
        />
      </Button>
    </PinTypeMenu>
  );
}
