import { useId, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { cn } from "@haptic/ui/lib/utils";
import { NumericDragField } from "./numeric-drag-field";
import { AXES, applyEdit, endsOf, formatRangeSummary, toValue, type Ends, type RangeFieldKind, type RangeFieldValue } from "./range-values";

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
            data-testid={testId ? `${testId}-${axes[axis] ? `${axes[axis].key}-` : ""}${end}` : undefined}
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
