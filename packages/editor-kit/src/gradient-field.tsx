import { useId, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@haptic/ui/lib/utils";
import { KEY_NEIGHBOUR_GAP, type GradientStop } from "./curve-keys";
import { GradientEditor } from "./gradient-editor";
import { gradientBackground } from "./gradient-colors";

export type { GradientStop } from "./curve-keys";

export interface GradientFieldProps {
  id?: string;
  "aria-label": string;
  /** Host-normalized: sorted, first `t` = 0, last `t` = 1. */
  value: readonly GradientStop[];
  onChange: (next: GradientStop[]) => void;
  minStops?: number;
  maxStops?: number;
  defaultExpanded?: boolean;
  disabled?: boolean;
  /** Defaults to `gradient-<id>`. */
  "data-testid"?: string;
}

function toCurve(stops: readonly GradientStop[]) {
  return {
    Keys: stops.map((stop) => {
      const [x, y, z, w] = stop.color;
      return { Time: stop.t, Value: { x, y, z, w }, Interpolation: "linear", ArriveTangent: { x: 0, y: 0, z: 0, w: 0 }, LeaveTangent: { x: 0, y: 0, z: 0, w: 0 } };
    }),
    Before: "constant",
    After: "constant",
  };
}

/**
 * Particle gradient row: a bar that expands into the shared `GradientEditor` in its constrained mode
 * (0–1 locations, end stops locked, Linear blending, `minStops`–`maxStops`). The particle data keeps its
 * `{ t, color }` shape.
 */
export function GradientField({
  id,
  "aria-label": ariaLabel,
  value: stops,
  onChange,
  minStops = 2,
  maxStops = 8,
  defaultExpanded = false,
  disabled = false,
  "data-testid": testId,
}: GradientFieldProps) {
  const rootId = testId ?? (id ? `gradient-${id}` : "gradient-field");
  const editorId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const curve = toCurve(stops);

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* Raw toggle: a Button primitive would grow to 44px rows in the phone PropertyGrid. */}
      <button
        type="button"
        id={id}
        className="flex min-h-[var(--chrome-row,28px)] w-full min-w-0 touch-pan-y items-center gap-2 rounded-md border border-input bg-control px-2 outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
        aria-expanded={expanded}
        aria-controls={editorId}
        aria-label={`${ariaLabel} Gradient, ${stops.length} ${stops.length === 1 ? "Stop" : "Stops"}`}
        onClick={() => setExpanded((open) => !open)}
        data-testid={`${rootId}-toggle`}
      >
        <span aria-hidden="true" className="h-5 min-w-0 flex-1 rounded-sm border border-input" style={{ background: gradientBackground(curve) }} />
        <ChevronDownIcon aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-180")} />
      </button>
      {expanded ? (
        <div id={editorId}>
          <GradientEditor
            aria-label={ariaLabel}
            value={curve}
            constraints={{ fixedTime: true, lockEnds: true, interpolation: "linear", minKeys: minStops, maxKeys: maxStops, keyGap: KEY_NEIGHBOUR_GAP }}
            disabled={disabled}
            onChange={(next) => onChange(next.Keys.map((key) => {
              const entry = key as { Time: number; Value: { x: number; y: number; z: number; w: number } };
              return { t: entry.Time, color: [entry.Value.x, entry.Value.y, entry.Value.z, entry.Value.w] };
            }))}
            data-testid={rootId}
          />
        </div>
      ) : null}
    </div>
  );
}
