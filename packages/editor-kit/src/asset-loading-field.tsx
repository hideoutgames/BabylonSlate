import { useId } from "react";
import { assetLoadingPolicy, type AssetLoadingPolicy } from "@babylonslate/core";
import { Field, FieldDescription, FieldLabel } from "@babylonslate/ui/components/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";

const ASSET_LOADING_OPTIONS: ReadonlyArray<{ value: AssetLoadingPolicy; label: string }> = [
  { value: "soft", label: "Soft (Load On Demand)" },
  { value: "hard", label: "Hard (Load With Owner)" },
];

export type AssetLoadingFieldProps = {
  /** A declaration's stored `loading` (only `"hard"` is persisted); missing means Soft. */
  value?: AssetLoadingPolicy;
  onChange: (policy: AssetLoadingPolicy) => void;
  disabled?: boolean;
  /** Test id of the select trigger. */
  "data-testid"?: string;
};

/**
 * Loading policy of an asset or Class reference declaration. Choosing Soft is
 * the default, so hosts persist only Hard and drop the property for Soft.
 */
export function AssetLoadingField({
  value,
  onChange,
  disabled,
  "data-testid": testId,
}: AssetLoadingFieldProps) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>Loading</FieldLabel>
      <Select
        value={assetLoadingPolicy({ loading: value })}
        items={ASSET_LOADING_OPTIONS}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === "soft" || next === "hard") onChange(next);
        }}
      >
        <SelectTrigger
          id={id}
          className="min-h-[var(--chrome-row,28px)] w-full"
          disabled={disabled}
          aria-describedby={`${id}-description`}
          data-testid={testId}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {ASSET_LOADING_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <FieldDescription id={`${id}-description`}>
        Soft assets load on first use or through Load nodes. Hard assets load with their owner.
      </FieldDescription>
    </Field>
  );
}
