import { useId, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { cn } from "@haptic/ui/lib/utils";
import { CurveEditor } from "./curve-editor";
import { CURVE_CHANNELS, curveValue, editorKeys, sampleChannel, type CurveEditorKind, type CurveEditorValue } from "./curve-editor-model";
import { GradientEditor } from "./gradient-editor";
import { gradientBackground, gradientDomain } from "./gradient-colors";

function keyCount(value: CurveEditorValue | null | undefined): number {
  return Array.isArray(value?.Keys) ? value.Keys.length : 0;
}

/** Sparkline points (0–100 × 0–16) of one channel across the keys' time span, scaled to its own range. */
function sparkline(kind: CurveEditorKind, value: CurveEditorValue, channel: number): string {
  const keys = editorKeys(kind, value);
  if (keys.length === 0) return "0,8 100,8";
  const curve = curveValue(kind, keys, value.Before, value.After);
  const start = keys[0]!.time;
  const end = keys.length > 1 ? keys[keys.length - 1]!.time : start + 1;
  const samples = Array.from({ length: 33 }, (_, step) => sampleChannel(kind, curve, channel, start + ((end - start) * step) / 32));
  const low = Math.min(...samples);
  const high = Math.max(...samples);
  const span = high - low || 1;
  return samples.map((sample, step) => `${(step / 32) * 100},${(high - low ? 1 - (sample - low) / span : 0.5) * 14 + 1}`).join(" ");
}

/**
 * The collapsed look of a curve value: a sparkline (Float), three axis-coloured sparklines (Vector) or
 * a gradient strip (Color). Inspector rows, Data Tree cells and the Play Inspector share it.
 */
export function CurvePreview({ kind, value, className }: { kind: CurveEditorKind; value: CurveEditorValue; className?: string }) {
  if (kind === "color") {
    const keys = editorKeys("color", value);
    return (
      <span aria-hidden="true" className={cn("h-3 min-w-0 flex-1 rounded-sm border border-input", className)}
        style={{ background: gradientBackground(value, gradientDomain(keys)) }} />
    );
  }
  return (
    <svg className={cn("h-4 min-w-0 flex-1 overflow-visible", className)} viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true">
      {CURVE_CHANNELS[kind].map((channel, index) => (
        <polyline key={channel.label} className="fill-none" style={{ stroke: channel.stroke }} strokeWidth={1.5}
          vectorEffect="non-scaling-stroke" points={sparkline(kind, value, index)} />
      ))}
    </svg>
  );
}

export interface CurveValueFieldProps {
  kind: CurveEditorKind;
  value: CurveEditorValue;
  /** Once per finished drag and per discrete action: one undo entry each. */
  onChange: (next: ReturnType<typeof curveValue>) => void;
  "aria-label": string;
  disabled?: boolean;
  defaultExpanded?: boolean;
  "data-testid"?: string;
}

/**
 * Inspector row for a Float, Vector or Color Curve Structure: the collapsed preview and key count,
 * expanding in place to the curve editor. A Color Curve expands to its gradient, with **Channels** for
 * the per-channel curves.
 */
export function CurveValueField({
  kind, value, onChange, "aria-label": ariaLabel, disabled = false, defaultExpanded = false, "data-testid": testId = "curve-value",
}: CurveValueFieldProps) {
  const editorId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [channelsView, setChannelsView] = useState(false);
  const count = keyCount(value);
  const countLabel = `${count} ${count === 1 ? "Key" : "Keys"}`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* Raw toggle: a Button primitive would grow to 44px rows in the phone PropertyGrid. */}
      <button
        type="button"
        className="flex min-h-[var(--chrome-row,28px)] w-full min-w-0 touch-pan-y items-center gap-2 rounded-md border border-input bg-control px-2 outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
        aria-expanded={expanded}
        aria-controls={editorId}
        aria-label={`${ariaLabel}, ${countLabel}`}
        onClick={() => setExpanded((open) => !open)}
        data-testid={`${testId}-toggle`}
      >
        <CurvePreview kind={kind} value={value} />
        <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground tabular-nums">{countLabel}</span>
        <ChevronDownIcon aria-hidden="true" className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-180")} />
      </button>
      {expanded ? (
        <div id={editorId} className="flex min-w-0 flex-col gap-1">
          {kind === "color" ? (
            <Button type="button" variant="ghost" size="xs" className="self-end pointer-coarse:min-h-11" aria-pressed={channelsView}
              onClick={() => setChannelsView((open) => !open)} data-testid={`${testId}-channels`}>
              Channels
            </Button>
          ) : null}
          {kind === "color" && !channelsView ? (
            <GradientEditor aria-label={ariaLabel} value={value} disabled={disabled} onChange={onChange} data-testid={`${testId}-gradient`} />
          ) : (
            <CurveEditor kind={kind} aria-label={ariaLabel} value={value} disabled={disabled} onChange={onChange} data-testid={`${testId}-editor`} />
          )}
        </div>
      ) : null}
    </div>
  );
}
