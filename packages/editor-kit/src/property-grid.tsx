import type { ReactNode } from "react";
import { Button } from "@babylonslate/ui/components/button";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { SelectAllInput } from "./select-all-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import { Slider } from "@babylonslate/ui/components/slider";
import { cn } from "@babylonslate/ui/lib/utils";
import { NumericDragField } from "./numeric-drag-field";
import { humanizePropertyLabel } from "./humanize-property-label";
import { ColorField, type ColorValue } from "./color-field";
import { FlagsField } from "./flags-field";
import { PickerIdentity } from "./picker-identity";
import { type TypeVisualQuery } from "./type-visuals";
import { AssetPickerControl } from "./asset-picker-control";
import { CurveField, type CurveKey } from "./curve-field";
import { GradientField, type GradientStop } from "./gradient-field";
import "./styles/property-grid.css";

export type Vector3Value =
  [number, number, number] | [number, number, number, number];

export type RangeValue = [number, number];
export type Color4Value = [number, number, number, number];

interface PropertyRowBase {
  id: string;
  label: string;
  disabled?: boolean;
  /** Selection values differ; reset remains available even if the primary is at default. */
  mixed?: boolean;
  /** Shown under the control (Title Case labels stay on `label`). */
  description?: string;
  /** Overrides the Field `data-testid` (`property-row-${id}` by default). */
  testId?: string;
  /** Rendered verbatim after the label, e.g. "s", "/s", "deg"; never humanized. */
  unit?: string;
  /**
   * Compact control on the label line before Reset (e.g. ValueModeField).
   * Vertical orientation only; no horizontal caller passes one.
   */
  labelAccessory?: ReactNode;
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
      mixedAxes?: boolean[];
      sensitivity?: number;
      onChange: (value: Vector3Value) => void;
      /** Optional per-axis edit; `onChange` still handles whole-row reset. */
      onAxisChange?: (axis: number, value: number) => void;
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
      /** Keep text focusable and selectable for native copy without allowing edits. */
      readOnly?: boolean;
      value: string;
      defaultValue?: string;
      onChange: (value: string) => void;
      onCommit?: (value: string) => void;
    })
  | (PropertyRowBase & {
      kind: "enum";
      value: string;
      defaultValue?: string;
      options: Array<{ value: string; label: string; disabled?: boolean }>;
      onChange: (value: string) => void;
    })
  | (PropertyRowBase & {
      kind: "color";
      value: ColorValue | null;
      defaultValue?: ColorValue | null;
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
      /** Secondary type line on the picker button (Texture, Class, …). */
      displayType?: string;
      /** Type glyph on the picker button when a value is selected. */
      visual?: TypeVisualQuery;
      onPick: () => void;
      onChange: (value: string | null) => void;
    })
  | (PropertyRowBase & {
      kind: "range";
      /** `[min, max]`; editing one past the other moves both. */
      value: RangeValue;
      defaultValue?: RangeValue;
      min?: number;
      max?: number;
      sensitivity?: number;
      onChange: (value: RangeValue) => void;
      onCommit?: (value: RangeValue) => void;
    })
  | (PropertyRowBase & {
      kind: "curve";
      value: CurveKey[];
      defaultValue?: CurveKey[];
      valueMin?: number;
      valueMax?: number;
      axisLabels?: { start: string; end: string };
      minKeys?: number;
      maxKeys?: number;
      defaultExpanded?: boolean;
      onChange: (value: CurveKey[]) => void;
    })
  | (PropertyRowBase & {
      kind: "gradient";
      value: GradientStop[];
      defaultValue?: GradientStop[];
      minStops?: number;
      maxStops?: number;
      defaultExpanded?: boolean;
      onChange: (value: GradientStop[]) => void;
    })
  | (PropertyRowBase & {
      kind: "color4";
      /** RGBA, each 0–1; color and alpha edits emit one value. */
      value: Color4Value;
      defaultValue?: Color4Value;
      onChange: (value: Color4Value) => void;
    });

export interface PropertyGridProps {
  rows: PropertyRow[];
  /** Section heading rendered above the rows. */
  title?: string;
  /** Vertical stacks the label above the control (Details). Horizontal is name left, value right. */
  orientation?: "vertical" | "horizontal";
  /** Live inspection: disable edits without dimming the displayed values. */
  readOnly?: boolean;
  /** Screen-reader-only Field labels so the control can fill a list row. */
  hideLabels?: boolean;
  /** Nested list rows: no Field padding or divider. */
  density?: "default" | "compact";
  "data-testid"?: string;
}

function hasDefault(row: PropertyRow): boolean {
  return "defaultValue" in row && row.defaultValue !== undefined;
}

function isAtDefault(row: PropertyRow): boolean {
  if (row.mixed) return false;
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
    case "range":
      row.onChange(row.defaultValue!);
      row.onCommit?.(row.defaultValue!);
      break;
    case "curve":
      row.onChange(row.defaultValue!);
      break;
    case "gradient":
      row.onChange(row.defaultValue!);
      break;
    case "color4":
      row.onChange(row.defaultValue!);
      break;
  }
}

/** Labels point only at a single real control; compound rows name their parts. */
function rowHasLabelTarget(row: PropertyRow): boolean {
  switch (row.kind) {
    case "vector3":
    case "flags":
    case "range":
    case "curve":
    case "gradient":
      return false;
    default:
      return true;
  }
}

function RowControl({ row }: { row: PropertyRow }) {
  switch (row.kind) {
    case "number":
      return (
        <NumericDragField
          id={`property-${row.id}`}
          value={row.value}
          mixed={row.mixed}
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
                aria-label={`${humanizePropertyLabel(row.label)} ${axis}`}
                value={row.value[index] ?? 0}
                mixed={row.mixedAxes?.[index] ?? row.mixed}
                accent={axis.toLowerCase() as "x" | "y" | "z"}
                sensitivity={row.sensitivity}
                disabled={row.disabled}
                onChange={(next) => {
                  if (row.onAxisChange) {
                    row.onAxisChange(index, next);
                    return;
                  }
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
        <FieldLabel
          htmlFor={`property-${row.id}`}
          className="flex min-h-[var(--chrome-row,28px)] w-full items-center gap-2 rounded-md border border-input bg-control px-2 py-1"
        >
          <Checkbox
            id={`property-${row.id}`}
            aria-labelledby={`property-${row.id}-caption`}
            className="size-4"
            checked={row.mixed ? false : row.value}
            indeterminate={row.mixed}
            disabled={row.disabled}
            onCheckedChange={(checked) => row.onChange(checked === true)}
            data-testid={`property-${row.id}`}
          />
          <span aria-hidden="true" className="text-xs text-muted-foreground">
            {row.mixed ? "Mixed" : row.value ? "On" : "Off"}
          </span>
        </FieldLabel>
      );
    case "text":
      return (
        <SelectAllInput
          id={`property-${row.id}`}
          className="min-h-[var(--chrome-row,28px)] px-2"
          value={row.value}
          disabled={row.disabled}
          readOnly={row.readOnly}
          onChange={(event) => { if (!row.readOnly) row.onChange(event.target.value); }}
          onBlur={(event) => { if (!row.readOnly) row.onCommit?.(event.target.value); }}
          data-testid={`property-${row.id}`}
        />
      );
    case "enum":
      return (
        <Select
          value={row.value}
          disabled={row.disabled}
          onValueChange={(value) => row.onChange(String(value))}
        >
          <SelectTrigger
            id={`property-${row.id}`}
            className="min-h-[var(--chrome-row,28px)] w-full"
            disabled={row.disabled}
            data-testid={`property-${row.id}`}
          >
            {/* Base UI renders the raw value unless the label is formatted. */}
            <SelectValue>
              {(value: unknown) =>
                humanizePropertyLabel(
                  row.options.find((option) => option.value === value)?.label ??
                    String(value ?? ""),
                )
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {row.options.map((option) => (
              <SelectItem
                key={option.value}
                value={option.value}
                disabled={option.disabled}
              >
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
          aria-label={humanizePropertyLabel(row.label)}
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
            aria-label={humanizePropertyLabel(row.label)}
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
    case "asset": {
      const selected = Boolean(row.displayLabel ?? row.value);
      return (
        <AssetPickerControl value={row.value}>
          <Button
            id={`property-${row.id}`}
            variant="outline"
            className="min-h-[var(--chrome-row,28px)] h-auto w-full justify-start"
            disabled={row.disabled}
            onClick={row.onPick}
            data-testid={`property-${row.id}`}
          >
            {selected && (row.visual || row.displayType) ? (
              <PickerIdentity
                label={
                  row.displayLabel ?? row.value ?? row.placeholder ?? "None"
                }
                description={row.displayType}
                visual={row.visual}
              />
            ) : (
              (row.displayLabel ?? row.value ?? row.placeholder ?? "None")
            )}
          </Button>
        </AssetPickerControl>
      );
    }
    case "range": {
      const [low, high] = row.value;
      const name = humanizePropertyLabel(row.label);
      return (
        <div className="grid min-w-0 grid-cols-2 gap-1">
          <NumericDragField
            label="Min"
            aria-label={`${name} Min`}
            value={low}
            mixed={row.mixed}
            min={row.min}
            max={row.max}
            sensitivity={row.sensitivity}
            disabled={row.disabled}
            onChange={(next) => row.onChange([next, Math.max(high, next)])}
            onDragEnd={(next) => row.onCommit?.([next, Math.max(high, next)])}
            data-testid={`property-${row.id}-min`}
          />
          <NumericDragField
            label="Max"
            aria-label={`${name} Max`}
            value={high}
            mixed={row.mixed}
            min={row.min}
            max={row.max}
            sensitivity={row.sensitivity}
            disabled={row.disabled}
            onChange={(next) => row.onChange([Math.min(low, next), next])}
            onDragEnd={(next) => row.onCommit?.([Math.min(low, next), next])}
            data-testid={`property-${row.id}-max`}
          />
        </div>
      );
    }
    case "curve":
      return (
        <CurveField
          id={`property-${row.id}`}
          aria-label={humanizePropertyLabel(row.label)}
          value={row.value}
          valueMin={row.valueMin}
          valueMax={row.valueMax}
          axisLabels={row.axisLabels}
          minKeys={row.minKeys}
          maxKeys={row.maxKeys}
          defaultExpanded={row.defaultExpanded}
          disabled={row.disabled}
          onChange={row.onChange}
          data-testid={`property-${row.id}`}
        />
      );
    case "gradient":
      return (
        <GradientField
          id={`property-${row.id}`}
          aria-label={humanizePropertyLabel(row.label)}
          value={row.value}
          minStops={row.minStops}
          maxStops={row.maxStops}
          defaultExpanded={row.defaultExpanded}
          disabled={row.disabled}
          onChange={row.onChange}
          data-testid={`property-${row.id}`}
        />
      );
    case "color4": {
      const [r, g, b, a] = row.value;
      return (
        <ColorField
          id={`property-${row.id}`}
          aria-label={humanizePropertyLabel(row.label)}
          value={[r, g, b]}
          alpha={a}
          disabled={row.disabled}
          onChange={([nextR, nextG, nextB]) => row.onChange([nextR, nextG, nextB, a])}
          onAlphaChange={(alpha) => row.onChange([r, g, b, alpha])}
          data-testid={`property-${row.id}`}
        />
      );
    }
  }
}

function rowResetButton(row: PropertyRow) {
  if (!hasDefault(row) || row.disabled || (row.kind === "text" && row.readOnly)) return null;
  return (
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
  );
}

function readOnlyPropertyRow(row: PropertyRow): PropertyRow {
  const next = { ...row, disabled: true, onChange: () => {} };
  if ("onCommit" in next) next.onCommit = undefined;
  if ("onAxisChange" in next) next.onAxisChange = undefined;
  if ("onPick" in next) next.onPick = () => {};
  return next;
}

/** Typed property rows with per-property reset-to-default (engineplan §7.4). */
export function PropertyGrid({
  rows,
  title,
  orientation = "vertical",
  readOnly = false,
  hideLabels = false,
  density = "default",
  "data-testid": testId,
}: PropertyGridProps) {
  const compact = density === "compact";
  return (
    <div
      className="flex min-w-0 flex-col gap-0"
      data-slot="property-grid"
      data-readonly={readOnly || undefined}
      data-hide-labels={hideLabels || undefined}
      data-density={density}
      data-testid={testId}
    >
      {title ? (
        <h3 className="bg-panel-header px-2 py-1.5 text-xs font-semibold text-foreground">
          {title}
        </h3>
      ) : null}
      <FieldGroup className="gap-0">
        {rows.map((source) => {
          const row = readOnly ? readOnlyPropertyRow(source) : source;
          const label = (
            <FieldLabel
              id={`property-${row.id}-caption`}
              htmlFor={rowHasLabelTarget(row) ? `property-${row.id}` : undefined}
              className={
                hideLabels
                  ? "sr-only"
                  : cn("w-auto min-w-0 flex-1 truncate", row.unit && "gap-1")
              }
            >
              {humanizePropertyLabel(row.label)}
              {row.unit ? (
                <span className="font-normal text-muted-foreground">
                  {` (${row.unit})`}
                </span>
              ) : null}
            </FieldLabel>
          );
          return (
            <Field
              key={row.id}
              orientation={orientation}
              data-testid={row.testId ?? `property-row-${row.id}`}
              data-disabled={row.disabled || undefined}
              data-kind={row.kind}
              data-described={row.description ? true : undefined}
              className={
                compact
                  ? "gap-0.5 px-0 py-0"
                  : "gap-0.5 border-b border-border/30 px-2 py-1"
              }
            >
              {orientation === "horizontal" ? (
                <>
                  {label}
                  <FieldContent className="min-w-0">
                    <RowControl row={row} />
                    {row.description ? (
                      <FieldDescription>{row.description}</FieldDescription>
                    ) : null}
                  </FieldContent>
                </>
              ) : (
                <>
                  <div className="flex min-w-0 items-center gap-1">
                    {label}
                    {row.labelAccessory}
                    {rowResetButton(row)}
                  </div>
                  <div className="min-w-0">
                    <RowControl row={row} />
                    {row.description ? (
                      <FieldDescription>{row.description}</FieldDescription>
                    ) : null}
                  </div>
                </>
              )}
            </Field>
          );
        })}
      </FieldGroup>
    </div>
  );
}
