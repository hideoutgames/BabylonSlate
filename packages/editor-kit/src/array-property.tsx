import { useId } from "react";
import { RotateCcwIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { Field, FieldDescription, FieldLabel } from "@babylonslate/ui/components/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@babylonslate/ui/components/select";
import { EntryListEditor } from "./entry-list-editor";

export type ArrayPropertyOption<T> = {
  /** Stable identity used by the picker; values may be strings, numbers, or objects. */
  id: string;
  label: string;
  value: T;
  disabled?: boolean;
};

export type ArrayPropertyProps<T> = {
  label: string;
  value: readonly T[];
  options: readonly ArrayPropertyOption<T>[];
  onChange: (value: T[]) => void;
  /** Defaults to Object.is. Supply a value identity comparison for object arrays. */
  isEqual?: (left: T, right: T) => boolean;
  unique?: boolean;
  /** Host-owned compatibility rule. index equals value.length when adding. */
  isOptionAllowed?: (option: T, index: number, value: readonly T[]) => boolean;
  minItems?: number;
  maxItems?: number;
  defaultValue?: readonly T[];
  description?: string;
  emptyLabel?: string;
  itemLabel?: string;
  addLabel?: string;
  disabled?: boolean;
  "data-testid"?: string;
};

/** Reorderable array property with typed choices and optional uniqueness/compatibility constraints. */
export function ArrayProperty<T>({
  label, value, options, onChange, isEqual = Object.is, unique = false,
  isOptionAllowed, minItems = 0, maxItems = Number.POSITIVE_INFINITY,
  defaultValue, description, emptyLabel = "None", itemLabel = "Item",
  addLabel = "Add Item", disabled = false, "data-testid": testId = "array-property",
}: ArrayPropertyProps<T>) {
  const id = useId();
  const minimum = Number.isFinite(minItems) ? Math.max(0, Math.floor(minItems)) : 0;
  const maximum = Number.isFinite(maxItems) ? Math.max(minimum, Math.floor(maxItems)) : Number.POSITIVE_INFINITY;
  const optionFor = (item: T) => options.find((option) => isEqual(option.value, item));
  const allowed = (option: ArrayPropertyOption<T>, index: number) =>
    !option.disabled &&
    (!unique || !value.some((item, other) => other !== index && isEqual(item, option.value))) &&
    (isOptionAllowed?.(option.value, index, value) ?? true);
  const nextOption = options.find((option) => allowed(option, value.length));
  const atDefault = defaultValue !== undefined && value.length === defaultValue.length &&
    value.every((item, index) => isEqual(item, defaultValue[index]!));
  const change = (next: T[]) => {
    if (!disabled) onChange(next);
  };

  return (
    <Field data-testid={testId} data-disabled={disabled || undefined} aria-labelledby={`${id}-label`} className="gap-1">
      <div className="flex min-w-0 items-center gap-1">
        <FieldLabel id={`${id}-label`} className="min-w-0 flex-1">{label}</FieldLabel>
        {defaultValue !== undefined ? <Button
          type="button" variant="ghost" size="icon-sm" aria-label={`Reset ${label}`}
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11"
          disabled={disabled || atDefault} onClick={() => change([...defaultValue])}
        ><RotateCcwIcon /></Button> : null}
      </div>
      <fieldset disabled={disabled} className="min-w-0">
        <legend className="sr-only">{label}</legend>
        {value.length === 0 ? <FieldDescription>{emptyLabel}</FieldDescription> : null}
        <EntryListEditor
          items={value} onChange={change} minItems={minimum}
          maxItems={nextOption ? maximum : value.length}
          onCreate={() => nextOption!.value}
          getItemKey={unique ? (item) => optionFor(item)?.id ?? String(item) : undefined}
          addLabel={addLabel} touchAdaptive data-testid={`${testId}-entries`}
          renderItem={({ item, index, onChange: update }) => {
            const selected = optionFor(item);
            return <Select
              value={selected?.id ?? null} disabled={disabled}
              items={options.map((option) => ({ value: option.id, label: option.label }))}
              onValueChange={(next) => {
                const option = options.find((entry) => entry.id === next);
                if (!disabled && option && allowed(option, index)) update(option.value);
              }}
            >
              <SelectTrigger size="sm" className="w-full pointer-coarse:min-h-11" aria-label={`${label} ${itemLabel} ${index + 1}`}>
                <SelectValue placeholder="Select Item" />
              </SelectTrigger>
              <SelectContent><SelectGroup>
                {options.map((option) => <SelectItem key={option.id} value={option.id} disabled={!allowed(option, index)}>{option.label}</SelectItem>)}
              </SelectGroup></SelectContent>
            </Select>;
          }}
        />
      </fieldset>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}
