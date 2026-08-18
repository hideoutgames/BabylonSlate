import type { AudioWaveformPeak } from "@babylonslate/assets";

const WAVEFORM_WIDTH = 256;
const WAVEFORM_HEIGHT = 56;

export function AudioPreviewWaveform({
  peaks,
  durationSeconds,
}: {
  peaks: readonly AudioWaveformPeak[];
  durationSeconds: number | null;
}) {
  const bars =
    peaks.length > 0
      ? peaks
      : Array.from({ length: 128 }, () => ({ min: 0, max: 0 }));
  const barWidth = WAVEFORM_WIDTH / bars.length;
  const mid = WAVEFORM_HEIGHT / 2;
  return (
    <div className="min-w-0 flex-1">
      <svg
        viewBox={`0 0 ${WAVEFORM_WIDTH} ${WAVEFORM_HEIGHT}`}
        className="text-primary h-14 w-full"
        data-testid="audio-preview-waveform"
        role="img"
        aria-label="Waveform"
      >
        <rect width={WAVEFORM_WIDTH} height={WAVEFORM_HEIGHT} fill="transparent" />
        {bars.map((peak, index) => {
          const max = clampUnit(peak.max);
          const min = clampUnit(peak.min);
          const yMax = mid - max * (mid - 2);
          const yMin = mid - min * (mid - 2);
          const top = Math.min(yMax, yMin);
          const height = Math.max(1, Math.abs(yMin - yMax));
          return (
            <rect
              key={index}
              x={index * barWidth + 0.2}
              y={top}
              width={Math.max(0.4, barWidth - 0.4)}
              height={height}
              fill="currentColor"
            />
          );
        })}
      </svg>
      {durationSeconds != null && durationSeconds > 0 ? (
        <p
          className="text-muted-foreground text-xs"
          data-testid="audio-preview-duration"
        >
          {durationSeconds.toFixed(2)} s
        </p>
      ) : null}
    </div>
  );
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}
