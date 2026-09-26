import type { AudioWaveformPeak } from "@babylonslate/assets";
import { cn } from "@babylonslate/ui/lib/utils";

const WAVEFORM_WIDTH = 256;
const WAVEFORM_HEIGHT = 56;
const RULER_STEPS = 4;

export function AudioPreviewWaveform({
  peaks,
  durationSeconds,
  color,
  className,
}: {
  peaks: readonly AudioWaveformPeak[];
  durationSeconds: number | null;
  color?: string;
  className?: string;
}) {
  const bars =
    peaks.length > 0
      ? peaks
      : Array.from({ length: 128 }, () => ({ min: 0, max: 0 }));
  const barWidth = WAVEFORM_WIDTH / bars.length;
  const mid = WAVEFORM_HEIGHT / 2;
  const hasDuration = durationSeconds != null && durationSeconds > 0;
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col gap-1", className)}>
      <div className="relative min-h-16 flex-1 overflow-hidden rounded-md border border-border bg-sidebar">
        <div aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-border" />
        <svg
          viewBox={`0 0 ${WAVEFORM_WIDTH} ${WAVEFORM_HEIGHT}`}
          preserveAspectRatio="none"
          className="absolute inset-0 size-full text-primary"
          style={color ? { color } : undefined}
          data-testid="audio-preview-waveform"
          role="img"
          aria-label="Waveform"
        >
          {bars.map((peak, index) => {
            const max = clampUnit(peak.max);
            const min = clampUnit(peak.min);
            const yMax = mid - max * (mid - 2);
            const yMin = mid - min * (mid - 2);
            const top = Math.min(yMax, yMin);
            const height = Math.max(0.5, Math.abs(yMin - yMax));
            return (
              <rect
                key={index}
                x={index * barWidth + barWidth * 0.15}
                y={top}
                width={Math.max(0.4, barWidth * 0.7)}
                height={height}
                fill="currentColor"
              />
            );
          })}
        </svg>
        {peaks.length === 0 ? (
          <span className="absolute inset-x-0 bottom-2 text-center text-xs text-muted-foreground">
            No Waveform
          </span>
        ) : null}
      </div>
      <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground" aria-hidden={!hasDuration}>
        {hasDuration ? (
          Array.from({ length: RULER_STEPS + 1 }, (_, step) => {
            const seconds = (durationSeconds * step) / RULER_STEPS;
            return step === RULER_STEPS ? (
              <span key={step} data-testid="audio-preview-duration">
                {formatSeconds(seconds, durationSeconds)}
              </span>
            ) : (
              <span key={step}>{formatSeconds(seconds, durationSeconds)}</span>
            );
          })
        ) : (
          <span>&nbsp;</span>
        )}
      </div>
    </div>
  );
}

function formatSeconds(seconds: number, total: number): string {
  return total < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}
