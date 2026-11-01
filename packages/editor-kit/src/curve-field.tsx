import { useId, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@haptic/ui/lib/utils";
import { KEY_NEIGHBOUR_GAP, clampNumber, type CurveKey } from "./curve-keys";
import { CurveEditor } from "./curve-editor";

export type { CurveKey } from "./curve-keys";

export interface CurveFieldProps {
  id?: string;
  "aria-label": string;
  /** Host-normalized: sorted, first `t` = 0, last `t` = 1. */
  value: readonly CurveKey[];
  /** Called once per finished drag and per discrete action. */
  onChange: (next: CurveKey[]) => void;
  valueMin?: number;
  valueMax?: number;
  axisLabels?: { start: string; end: string };
  minKeys?: number;
  maxKeys?: number;
  defaultExpanded?: boolean;
  disabled?: boolean;
  /** Defaults to `curve-<id>`. */
  "data-testid"?: string;
}

function sparkline(keys: readonly CurveKey[], valueMin?: number, valueMax?: number): string {
  const values = keys.map((key) => key.value);
  const bottom = Number.isFinite(valueMin) ? valueMin! : Math.min(0, ...values);
  const top = Number.isFinite(valueMax) ? valueMax! : Math.max(1, ...values);
  const span = top > bottom ? top - bottom : 1;
  return keys.map((key) => `${key.t * 100},${(1 - clampNumber((key.value - bottom) / span, 0, 1)) * 16}`).join(" ");
}

/**
 * Particle curve row: a sparkline that expands into the shared `CurveEditor` in its constrained mode
 * (0–1 time, end keys locked, Linear keys, `minKeys`–`maxKeys`, values within `valueMin`–`valueMax`).
 * The particle data keeps its `{ t, value }` shape.
 */
export function CurveField({
  id,
  "aria-label": ariaLabel,
  value: keys,
  onChange,
  valueMin,
  valueMax,
  axisLabels = { start: "Birth", end: "Death" },
  minKeys = 2,
  maxKeys = 8,
  defaultExpanded = false,
  disabled = false,
  "data-testid": testId,
}: CurveFieldProps) {
  const rootId = testId ?? (id ? `curve-${id}` : "curve-field");
  const editorId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const points = sparkline(keys, valueMin, valueMax);
  const curve = {
    Keys: keys.map((key) => ({ Time: key.t, Value: key.value, Interpolation: "linear", ArriveTangent: 0, LeaveTangent: 0 })),
    Before: "constant",
    After: "constant",
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* Raw toggle: a Button primitive would grow to 44px rows in the phone PropertyGrid. */}
      <button
        type="button"
        id={id}
        className="flex min-h-[var(--chrome-row,28px)] w-full min-w-0 touch-pan-y items-center gap-2 rounded-md border border-input bg-control px-2 outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
        aria-expanded={expanded}
        aria-controls={editorId}
        aria-label={`${ariaLabel} Curve, ${keys.length} ${keys.length === 1 ? "Key" : "Keys"}`}
        onClick={() => setExpanded((open) => !open)}
        data-testid={`${rootId}-toggle`}
      >
        <svg className="h-4 min-w-0 flex-1 overflow-visible" viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true">
          <polygon className="fill-muted" points={`0,16 ${points} 100,16`} />
          <polyline className="fill-none stroke-foreground" strokeWidth={1.5} vectorEffect="non-scaling-stroke" points={points} />
        </svg>
        <ChevronDownIcon aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-180")} />
      </button>
      {expanded ? (
        <div id={editorId}>
          <CurveEditor
            kind="float"
            aria-label={ariaLabel}
            value={curve}
            constraints={{
              fixedTime: true, lockEnds: true, interpolation: "linear", minKeys, maxKeys, valueMin, valueMax,
              keyGap: KEY_NEIGHBOUR_GAP,
            }}
            axisLabels={axisLabels}
            disabled={disabled}
            onChange={(next) => onChange(next.Keys.map((key) => {
              const entry = key as { Time: number; Value: number };
              return { t: entry.Time, value: entry.Value };
            }))}
            data-testid={rootId}
          />
        </div>
      ) : null}
    </div>
  );
}
