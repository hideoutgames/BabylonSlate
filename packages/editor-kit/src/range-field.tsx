import { useId, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { cn } from "@haptic/ui/lib/utils";
import { NumericDragField } from "./numeric-drag-field";

/** Value kinds a range holds; matches the built-in range Structures. */
export type RangeFieldKind = "int" | "float" | "vec2" | "vec3" | "rotator";

/** `{ Min, Max }`: numbers, or axis records (`x`/`y`/`z`, `pitch`/`yaw`/`roll`). */
export type RangeFieldValue = { Min: unknown; Max: unknown };

type Axis = { key: string; label: string; accent?: "x" | "y" | "z" };

const AXES: Record<RangeFieldKind, readonly Axis[]> = {
  int: [],
  float: [],
  vec2: [{ key: "x", label: "X", accent: "x" }, { key: "y", label: "Y", accent: "y" }],
  vec3: [{ key: "x", label: "X", accent: "x" }, { key: "y", label: "Y", accent: "y" }, { key: "z", label: "Z", accent: "z" }],
  rotator: [{ key: "pitch", label: "Pitch" }, { key: "yaw", label: "Yaw" }, { key: "roll", label: "Roll" }],
};

type Ends = { min: number[]; max: number[] };

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function read(kind: RangeFieldKind, value: unknown): number[] {
  const axes = AXES[kind];
  if (axes.length === 0) return [finite(value)];
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return axes.map((axis) => finite(record[axis.key]));
}

function write(kind: RangeFieldKind, values: readonly number[]): unknown {
  const axes = AXES[kind];
  if (axes.length === 0) return kind === "int" ? Math.trunc(values[0] ?? 0) : values[0] ?? 0;
  return Object.fromEntries(axes.map((axis, index) => [axis.key, values[index] ?? 0]));
}

function endsOf(kind: RangeFieldKind, value: RangeFieldValue | null | undefined): Ends {
  return { min: read(kind, value?.Min), max: read(kind, value?.Max) };
}

function toValue(kind: RangeFieldKind, ends: Ends): RangeFieldValue {
  return { Min: write(kind, ends.min), Max: write(kind, ends.max) };
}

/** The range with Min at most Max on every axis; crossing axes are swapped. */
export function normalizeRangeFieldValue(kind: RangeFieldKind, value: RangeFieldValue | null | undefined): RangeFieldValue {
  const { min, max } = endsOf(kind, value);
  return toValue(kind, { min: min.map((a, i) => Math.min(a, max[i]!)), max: max.map((b, i) => Math.max(b, min[i]!)) });
}

function formatNumber(value: number, kind: RangeFieldKind): string {
  const text = kind === "int" ? String(Math.trunc(value)) : value.toFixed(2);
  return text.replace("-", "−");
}

/** One-line summary, as collapsed rows and Data Tree cells show it: `2–5`, `−5, 0, −5 – 5, 2, 5`. */
export function formatRangeSummary(kind: RangeFieldKind, value: RangeFieldValue | null | undefined, unit?: string): string {
  const { min, max } = endsOf(kind, value);
  const suffix = unit ? (unit === "deg" ? "°" : ` ${unit}`) : "";
  const side = (values: number[]) => values.map((entry) => formatNumber(entry, kind)).join(", ") + suffix;
  return AXES[kind].length === 0 ? `${side(min)}–${side(max)}` : `${side(min)} – ${side(max)}`;
}

/**
 * Applies one end's edit. While an edit is live, an end dragged or typed past the other pushes it along;
 * a typed edit that ends past the other end swaps instead, so the other end keeps its value. Measured from
 * `baseline`, the range when the edit began, so moving back restores the pushed end.
 */
function applyEdit(
  baseline: Ends, axis: number, end: "min" | "max", raw: number, integer: boolean, commitTyped: boolean,
): Ends {
  const value = integer ? Math.round(raw) : raw;
  const min = [...baseline.min];
  const max = [...baseline.max];
  if (end === "min") {
    const other = baseline.max[axis]!;
    if (value > other && commitTyped) { min[axis] = other; max[axis] = value; }
    else { min[axis] = value; max[axis] = Math.max(other, value); }
  } else {
    const other = baseline.min[axis]!;
    if (value < other && commitTyped) { max[axis] = other; min[axis] = value; }
    else { max[axis] = value; min[axis] = Math.min(other, value); }
  }
  return { min, max };
}

export interface RangeFieldProps {
  kind: RangeFieldKind;
  value: RangeFieldValue;
  /** Every live change, Min never above Max. */
  onChange: (value: RangeFieldValue) => void;
  /** Once per finished scrub or typed edit, with the final value (one undo entry). */
  onCommit?: (value: RangeFieldValue) => void;
  "aria-label": string;
  /** Shown after each value (`deg` shows `°`). */
  unit?: string;
  min?: number;
  max?: number;
  sensitivity?: number;
  disabled?: boolean;
  mixed?: boolean;
  /** Vector and rotator ranges only: start expanded. */
  defaultExpanded?: boolean;
  "data-testid"?: string;
}

/**
 * Min – Max editor for a range. Integer and Float ranges edit in the row; Vector 2, Vector and Rotator
 * ranges show a one-line summary that expands to a Min – Max pair per axis. Min is always at most Max.
 */
export function RangeField({
  kind, value, onChange, onCommit, "aria-label": ariaLabel, unit, min, max, sensitivity, disabled, mixed,
  defaultExpanded = false, "data-testid": testId,
}: RangeFieldProps) {
  const axes = AXES[kind];
  const [expanded, setExpanded] = useState(defaultExpanded);
  const editorId = useId();
  const baseline = useRef<Ends | null>(null);
  const current = endsOf(kind, value);
  const integer = kind === "int";
  const fieldUnit = unit === "deg" || kind === "rotator" ? "°" : unit;

  const change = (axis: number, end: "min" | "max", next: number) => {
    baseline.current ??= current;
    onChange(toValue(kind, applyEdit(baseline.current, axis, end, next, integer, false)));
  };
  const commit = (axis: number, end: "min" | "max", next: number, source: "drag" | "typed") => {
    const start = baseline.current ?? current;
    baseline.current = null;
    const final = toValue(kind, applyEdit(start, axis, end, next, integer, source === "typed"));
    if (JSON.stringify(final) !== JSON.stringify(value)) onChange(final);
    onCommit?.(final);
  };

  const pair = (axis: number, label: string, prefix: string) => (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1">
      {(["min", "max"] as const).map((end, index) => {
        const field = (
          <NumericDragField
            key={end}
            label={index === 0 ? label : undefined}
            accent={axes[axis]?.accent}
            aria-label={`${prefix} ${end === "min" ? "Min" : "Max"}`}
            value={(end === "min" ? current.min : current.max)[axis]!}
            mixed={mixed}
            min={min}
            max={max}
            precision={integer ? 0 : undefined}
            sensitivity={sensitivity ?? (integer ? 0.1 : undefined)}
            unit={fieldUnit}
            disabled={disabled}
            onChange={(next) => change(axis, end, next)}
            onDragEnd={(next, source) => commit(axis, end, next, source)}
            data-testid={testId ? `${testId}-${axes[axis]?.key ?? "value"}-${end}` : undefined}
          />
        );
        return index === 0 ? field : [<span key="dash" aria-hidden="true" className="text-xs text-muted-foreground">{"–"}</span>, field];
      })}
    </div>
  );

  if (axes.length === 0) return <div data-testid={testId}>{pair(0, "", ariaLabel)}</div>;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full min-w-0 justify-between gap-2 font-normal tabular-nums pointer-coarse:min-h-11"
        aria-expanded={expanded}
        aria-controls={editorId}
        aria-label={`${ariaLabel}, ${formatRangeSummary(kind, value, kind === "rotator" ? "deg" : unit)}`}
        onClick={() => setExpanded((open) => !open)}
        data-testid={testId ? `${testId}-toggle` : undefined}
      >
        <span className="min-w-0 truncate">{mixed ? "Mixed" : formatRangeSummary(kind, value, kind === "rotator" ? "deg" : unit)}</span>
        <ChevronDownIcon data-icon="inline-end" className={cn("text-muted-foreground", expanded && "rotate-180")} />
      </Button>
      {expanded ? (
        <div id={editorId} className="flex min-w-0 flex-col gap-1">
          {axes.map((axis, index) => <div key={axis.key}>{pair(index, axis.label, `${ariaLabel} ${axis.label}`)}</div>)}
        </div>
      ) : null}
    </div>
  );
}
