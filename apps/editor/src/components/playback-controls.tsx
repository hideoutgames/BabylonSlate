import { useSyncExternalStore } from "react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@haptic/ui/components/select";
import { Slider } from "@haptic/ui/components/slider";

/** Preview speeds, slowest first. */
const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 1.5, 2] as const;

/** A playhead in ms that changes every frame while it plays. */
export type PlaybackTime = {
  get: () => number;
  subscribe: (listener: () => void) => () => void;
};

function sliderNumber(next: number | readonly number[]): number | undefined {
  const value = Array.isArray(next) ? next[0] : next;
  return typeof value === "number" ? value : undefined;
}

/** Frame and time beside the scrubber, on one line at a steady width while it plays. */
function PlaybackPosition({
  frameIndex,
  frameCount,
  timeMs,
  durationMs,
  testId,
}: {
  frameIndex: number;
  frameCount: number;
  timeMs: number;
  durationMs: number;
  testId: string;
}) {
  const frameDigits = String(frameCount).length;
  const timeDigits = String(Math.round(durationMs)).length;
  return (
    <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground" data-testid={testId}>
      Frame{" "}
      <span className="inline-block text-right text-foreground" style={{ minWidth: `${frameDigits}ch` }}>
        {frameIndex + 1}
      </span>
      /{frameCount}
      {" · "}
      <span className="inline-block text-right text-foreground" style={{ minWidth: `${timeDigits}ch` }}>
        {Math.round(timeMs)}
      </span>
      /{Math.round(durationMs)} ms
    </span>
  );
}

/**
 * A preview's scrubber and its Frame · ms readout, which follow `time` on every frame without re-rendering the
 * preview around them. Dragging reports `onSeek`; the caller pauses.
 */
export function PlaybackScrubber({
  time,
  durationMs,
  frameCount,
  frameAt,
  onSeek,
  testIdPrefix,
}: {
  time: PlaybackTime;
  durationMs: number;
  frameCount: number;
  /** The 0-based frame shown at `timeMs`. */
  frameAt: (timeMs: number) => number;
  onSeek: (timeMs: number) => void;
  /** Test ids `${prefix}-scrubber` and `${prefix}-position`. */
  testIdPrefix: string;
}) {
  const timeMs = useSyncExternalStore(time.subscribe, time.get, time.get);
  return (
    <>
      <Slider
        className="min-w-0 flex-1"
        min={0}
        max={durationMs}
        step={1}
        value={timeMs}
        aria-label="Playback"
        data-testid={`${testIdPrefix}-scrubber`}
        onValueChange={(next) => {
          const value = sliderNumber(next);
          if (value !== undefined) onSeek(value);
        }}
      />
      <PlaybackPosition
        frameIndex={frameAt(timeMs)}
        frameCount={frameCount}
        timeMs={timeMs}
        durationMs={durationMs}
        testId={`${testIdPrefix}-position`}
      />
    </>
  );
}

/** A preview's Speed, 0.25× to 2×. */
export function PlaybackSpeedSelect({
  value,
  onChange,
  "data-testid": testId,
}: {
  value: number;
  onChange: (speed: number) => void;
  "data-testid"?: string;
}) {
  return (
    <Select
      value={String(value)}
      onValueChange={(next) => {
        if (next) onChange(Number(next));
      }}
      items={PLAYBACK_SPEEDS.map((speed) => ({ value: String(speed), label: `${speed}×` }))}
    >
      <SelectTrigger size="sm" aria-label="Speed" className="w-20" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {PLAYBACK_SPEEDS.map((speed) => (
            <SelectItem key={speed} value={String(speed)}>
              {`${speed}×`}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
