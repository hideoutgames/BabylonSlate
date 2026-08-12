import { Button } from "@babylonslate/ui/components/button";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import { Input } from "@babylonslate/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import { NumericDragField } from "./numeric-drag-field";
import { humanizePropertyLabel } from "./humanize-property-label";

export type Vector3Value = [number, number, number];

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
      value: Vector3Value;
      defaultValue?: Vector3Value;
      onChange: (value: Vector3Value) => void;
    })
  | (PropertyRowBase & {
      kind: "asset";
      value: string | null;
      defaultValue?: string | null;
      placeholder?: string;
      onPick: () => void;
      onChange: (value: string | null) => void;
    });

export interface PropertyGridProps {
  rows: PropertyRow[];
  /** Section heading rendered above the rows. */
  title?: string;
  "data-testid"?: string;
}

function toHex(color: Vector3Value): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

function fromHex(hex: string): Vector3Value {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ];
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
          label={row.label}
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
                  const value: Vector3Value = [...row.value];
                  value[index] = next;
                  row.onChange(value);
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
        <input
          type="color"
          id={`property-${row.id}`}
          className="min-h-[var(--chrome-row,28px)] w-full rounded-md border border-input bg-background"
          value={toHex(row.value)}
          disabled={row.disabled}
          onChange={(event) => row.onChange(fromHex(event.target.value))}
          data-testid={`property-${row.id}`}
        />
      );
    case "asset":
      return (
        <Button
          variant="outline"
          className="min-h-[var(--chrome-row,28px)] w-full justify-start"
          disabled={row.disabled}
          onClick={row.onPick}
          data-testid={`property-${row.id}`}
        >
          {row.value ?? row.placeholder ?? "None"}
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
      {rows.map((row) => (
        <div
          key={row.id}
          data-testid={`property-row-${row.id}`}
          className="grid min-h-[var(--chrome-row,28px)] grid-cols-[minmax(0,8rem)_minmax(0,1fr)] items-center gap-1 border-b border-border/60 px-2 py-0.5"
        >
          <label
            className="truncate text-sm font-medium text-foreground"
            htmlFor={`property-${row.id}`}
          >
            {humanizePropertyLabel(row.label)}
          </label>
          <div className="flex min-w-0 items-center gap-1">
            <div className="min-w-0 flex-1">
              <RowControl row={row} />
            </div>
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
        </div>
      ))}
    </div>
  );
}
