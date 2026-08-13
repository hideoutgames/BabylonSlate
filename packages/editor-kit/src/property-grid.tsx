import { Button } from "@babylonslate/ui/components/button";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import { Slider } from "@babylonslate/ui/components/slider";
import { NumericDragField } from "./numeric-drag-field";
import { humanizePropertyLabel } from "./humanize-property-label";
import { ColorField, type ColorValue } from "./color-field";
import { FlagsField } from "./flags-field";

export type Vector3Value = [number, number, number] | [number, number, number, number];

interface PropertyRowBase {
  id: string;
  label: string;
  disabled?: boolean;
}

export type PropertyRow =
  | (PropertyRowBase & {
      kind: "number";
      value: number;
      defaultValue?: number;
      min?: number;
      max?: number;
      sensitivity?: number;
      onChange: (value: number) => void;
      onCommit?: (value: number) => void;
    })
  | (PropertyRowBase & {
      kind: "vector3";
      value: Vector3Value;
      defaultValue?: Vector3Value;
      /** Axis labels; 2D mode hides the Z axis by passing two entries. */
      axes?: string[];
      sensitivity?: number;
      onChange: (value: Vector3Value) => void;
      onCommit?: (value: Vector3Value) => void;
    })
  | (PropertyRowBase & {
      kind: "boolean";
      value: boolean;
      defaultValue?: boolean;
      onChange: (value: boolean) => void;
    })
  | (PropertyRowBase & {
      kind: "text";
      value: string;
      defaultValue?: string;
      onChange: (value: string) => void;
      onCommit?: (value: string) => void;
    })
  | (PropertyRowBase & {
      kind: "enum";
      value: string;
      defaultValue?: string;
      options: Array<{ value: string; label: string }>;
      onChange: (value: string) => void;
    })
  | (PropertyRowBase & {
      kind: "color";
      value: ColorValue;
      defaultValue?: ColorValue;
      onChange: (value: ColorValue) => void;
    })
  | (PropertyRowBase & {
      kind: "slider";
      value: number;
      defaultValue?: number;
      min: number;
      max: number;
      step?: number;
      onChange: (value: number) => void;
      onCommit?: (value: number) => void;
    })
  | (PropertyRowBase & {
      kind: "flags";
      value: number;
      defaultValue?: number;
      bitCount?: number;
      labels?: readonly string[];
      onChange: (value: number) => void;
    })
  | (PropertyRowBase & {
      kind: "asset";
      value: string | null;
      defaultValue?: string | null;
      placeholder?: string;
      /** Human name shown on the picker button; `value` stays the guid. */
      displayLabel?: string;
      onPick: () => void;
      onChange: (value: string | null) => void;
    });

export interface PropertyGridProps {
  rows: PropertyRow[];
  /** Section heading rendered above the rows. */
  title?: string;
  "data-testid"?: string;
}

function hasDefault(row: PropertyRow): boolean {
  return "defaultValue" in row && row.defaultValue !== undefined;
}

function isAtDefault(row: PropertyRow): boolean {
  if (!hasDefault(row)) return true;
  return (
    JSON.stringify(row.value) ===
    JSON.stringify((row as { defaultValue: unknown }).defaultValue)
  );
}

function resetRow(row: PropertyRow): void {
  if (!hasDefault(row)) return;
  switch (row.kind) {
    case "number":
      row.onChange(row.defaultValue!);
      row.onCommit?.(row.defaultValue!);
      break;
    case "vector3":
      row.onChange(row.defaultValue!);
      row.onCommit?.(row.defaultValue!);
      break;
    case "boolean":
      row.onChange(row.defaultValue!);
      break;
    case "text":
      row.onChange(row.defaultValue!);
      row.onCommit?.(row.defaultValue!);
      break;
    case "enum":
      row.onChange(row.defaultValue!);
      break;
    case "color":
      row.onChange(row.defaultValue!);
      break;
    case "slider":
      row.onChange(row.defaultValue!);
      row.onCommit?.(row.defaultValue!);
      break;
    case "flags":
      row.onChange(row.defaultValue!);
      break;
    case "asset":
      row.onChange(row.defaultValue ?? null);
      break;
  }
}

function RowControl({ row }: { row: PropertyRow }) {
  switch (row.kind) {
    case "number":
      return (
        <NumericDragField
          id={`property-${row.id}`}
          value={row.value}
          min={row.min}
          max={row.max}
          sensitivity={row.sensitivity}
          disabled={row.disabled}
          onChange={row.onChange}
          onDragEnd={row.onCommit}
          data-testid={`property-${row.id}`}
        />
      );
    case "vector3": {
      const axes = row.axes ?? ["X", "Y", "Z"];
      return (
        <div
          className="flex min-w-0 flex-nowrap gap-1"
          data-testid={`property-vector3-${row.id}`}
        >
          {axes.map((axis, index) => (
            <div key={axis} className="min-w-0 flex-1">
              <NumericDragField
                label={axis}
                value={row.value[index] ?? 0}
                accent={axis.toLowerCase() as "x" | "y" | "z"}
                sensitivity={row.sensitivity}
                disabled={row.disabled}
                onChange={(next) => {
                  const value = [...row.value];
                  value[index] = next;
                  row.onChange(value as typeof row.value);
                }}
                onDragEnd={() => row.onCommit?.(row.value)}
                data-testid={`property-${row.id}-${axis.toLowerCase()}`}
              />
            </div>
          ))}
        </div>
      );
    }
    case "boolean":
      return (
        <Checkbox
          id={`property-${row.id}`}
          className="size-4"
          checked={row.value}
          disabled={row.disabled}
          onCheckedChange={(checked) => row.onChange(checked === true)}
          data-testid={`property-${row.id}`}
        />
      );
    case "text":
      return (
        <Input
          id={`property-${row.id}`}
          className="min-h-[var(--chrome-row,28px)]"
          value={row.value}
          disabled={row.disabled}
          onChange={(event) => row.onChange(event.target.value)}
          onBlur={(event) => row.onCommit?.(event.target.value)}
          data-testid={`property-${row.id}`}
        />
      );
    case "enum":
      return (
        <Select
          value={row.value}
          onValueChange={(value) => row.onChange(String(value))}
        >
          <SelectTrigger
            id={`property-${row.id}`}
            className="min-h-[var(--chrome-row,28px)] w-full"
            data-testid={`property-${row.id}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {row.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {humanizePropertyLabel(option.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    case "color":
      return (
        <ColorField
          id={`property-${row.id}`}
          value={row.value}
          disabled={row.disabled}
          onChange={row.onChange}
          data-testid={`property-${row.id}`}
        />
      );
    case "slider":
      return (
        <div className="flex min-w-0 items-center gap-2">
          <Slider
            className="min-w-0 flex-1"
            value={row.value}
            min={row.min}
            max={row.max}
            step={row.step ?? (row.max - row.min <= 1 ? 0.01 : 1)}
            disabled={row.disabled}
            onValueChange={(next) => {
              const value = Array.isArray(next) ? next[0] : next;
              if (typeof value === "number") row.onChange(value);
            }}
            data-testid={`property-${row.id}-slider`}
          />
          <div className="w-20 shrink-0">
            <NumericDragField
              id={`property-${row.id}`}
              value={row.value}
              min={row.min}
              max={row.max}
              disabled={row.disabled}
              onChange={row.onChange}
              onDragEnd={row.onCommit}
              data-testid={`property-${row.id}`}
            />
          </div>
        </div>
      );
    case "flags":
      return (
        <FlagsField
          id={`property-${row.id}`}
          value={row.value}
          bitCount={row.bitCount}
          labels={row.labels}
          disabled={row.disabled}
          onChange={row.onChange}
          data-testid={`property-${row.id}`}
        />
      );
    case "asset":
      return (
        <Button
          id={`property-${row.id}`}
          variant="outline"
          className="min-h-[var(--chrome-row,28px)] w-full justify-start"
          disabled={row.disabled}
          onClick={row.onPick}
          data-testid={`property-${row.id}`}
        >
          {row.displayLabel ?? row.value ?? row.placeholder ?? "None"}
        </Button>
      );
  }
}

/** Typed property rows with per-property reset-to-default (engineplan §7.4). */
export function PropertyGrid({
  rows,
  title,
  "data-testid": testId,
}: PropertyGridProps) {
  return (
    <div className="flex flex-col gap-0" data-testid={testId}>
      {title ? (
        <h3 className="bg-secondary px-3 py-2 text-sm font-semibold text-foreground">
          {title}
        </h3>
      ) : null}
      <FieldGroup className="gap-0">
        {rows.map((row) => (
          <Field
            key={row.id}
            data-testid={`property-row-${row.id}`}
            data-disabled={row.disabled || undefined}
            className="gap-0.5 border-b border-border/60 px-2 py-1"
          >
            <div className="flex min-w-0 items-center gap-1">
              <FieldLabel
                htmlFor={
                  row.kind === "vector3" || row.kind === "flags"
                    ? undefined
                    : `property-${row.id}`
                }
                className="w-auto min-w-0 flex-1 truncate"
              >
                {humanizePropertyLabel(row.label)}
              </FieldLabel>
              {hasDefault(row) ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  disabled={isAtDefault(row)}
                  aria-label={`Reset ${humanizePropertyLabel(row.label)}`}
                  onClick={() => resetRow(row)}
                  data-testid={`property-${row.id}-reset`}
                >
                  <span aria-hidden="true">↺</span>
                </Button>
              ) : null}
            </div>
            <div className="min-w-0">
              <RowControl row={row} />
            </div>
          </Field>
        ))}
      </FieldGroup>
    </div>
  );
}
