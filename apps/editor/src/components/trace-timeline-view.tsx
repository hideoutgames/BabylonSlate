import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { TracePayload } from "@babylonslate/debugger";
import { TICK_BUDGET_MS } from "@babylonslate/debugger";
import { NumberField, SelectableText } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";
import { Slider } from "@babylonslate/ui/components/slider";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { frameTickMs, traceGraphBuckets } from "../lib/trace-view";
import { TraceEmptyState, useTraceTouch } from "./trace-inspection-controls";

export function TraceTimelineView({
  payload,
  index,
  onIndexChange,
  windowSize,
  onWindowSizeChange,
}: {
  payload: TracePayload;
  index: number;
  onIndexChange: (index: number) => void;
  windowSize: number | null;
  onWindowSizeChange: (size: number | null) => void;
}) {
  const frameId = useId();
  const chartRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const touch = useTraceTouch();
  const size = touch ? "touch-icon" : "icon-sm";
  const length = payload.frames.length;
  const max = Math.max(0, length - 1);
  const frame = payload.frames[index];
  const count = Math.min(length, windowSize ?? length);
  const start = Math.max(
    0,
    Math.min(length - count, index - Math.floor(count / 2)),
  );
  const end = start + count - 1;
  const limit = width
    ? Math.max(1, Math.min(200, Math.floor(width / (touch ? 12 : 4))))
    : 160;
  const buckets = useMemo(
    () => traceGraphBuckets(payload, start, end, limit),
    [payload, start, end, limit],
  );
  const selectedBucketIndex = buckets.findIndex(
    (bucket) => index >= bucket.start && index <= bucket.end,
  );
  const selectionFraction = count ? (index - start + 0.5) / count : 0;
  const scale =
    Math.max(
      TICK_BUDGET_MS,
      ...buckets.map((bucket) => bucket.scriptMs + bucket.physicsMs),
    ) * 1.12;
  const budgetTicks = useMemo(
    () =>
      payload.frames.flatMap((entry, i) =>
        frameTickMs(entry) > TICK_BUDGET_MS ? [i] : [],
      ),
    [payload],
  );
  const previousSpike = budgetTicks.findLast((i) => i < index);
  const nextSpike = budgetTicks.find((i) => i > index);
  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2"
      data-testid="trace-playback"
    >
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span data-testid="trace-playback-seed">
          <SelectableText>Seed {payload.seed}</SelectableText>
        </span>
        <span data-testid="trace-playback-frames">
          <SelectableText>
            {length} Frames · Fixed Delta {payload.dt.toFixed(4)} s
          </SelectableText>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="outline"
          size={size}
          aria-label="Previous Frame"
          title="Previous Frame"
          disabled={!frame || index === 0}
          onClick={() => onIndexChange(index - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          variant="outline"
          size={size}
          aria-label="Next Frame"
          title="Next Frame"
          disabled={!frame || index === max}
          onClick={() => onIndexChange(index + 1)}
        >
          <ChevronRightIcon />
        </Button>
        <Button
          variant="outline"
          size={size}
          aria-label="Previous Over Budget"
          title="Previous Over Budget"
          disabled={previousSpike === undefined}
          onClick={() => {
            if (previousSpike !== undefined) onIndexChange(previousSpike);
          }}
        >
          <ChevronsLeftIcon />
        </Button>
        <Button
          variant="outline"
          size={size}
          aria-label="Next Over Budget"
          title="Next Over Budget"
          disabled={nextSpike === undefined}
          onClick={() => {
            if (nextSpike !== undefined) onIndexChange(nextSpike);
          }}
        >
          <ChevronsRightIcon />
        </Button>
        <Button
          variant="outline"
          size={size}
          aria-label="Zoom In"
          title="Zoom In Around Selected Frame"
          disabled={count <= 1}
          onClick={() => onWindowSizeChange(Math.max(1, Math.ceil(count / 2)))}
        >
          <ZoomInIcon />
        </Button>
        <Button
          variant="outline"
          size={size}
          aria-label="Zoom Out"
          title="Zoom Out"
          disabled={count >= length}
          onClick={() =>
            onWindowSizeChange(count * 2 >= length ? null : count * 2)
          }
        >
          <ZoomOutIcon />
        </Button>
        <Button
          variant="outline"
          size={touch ? "touch" : "sm"}
          disabled={windowSize === null}
          onClick={() => onWindowSizeChange(null)}
        >
          Show All Frames
        </Button>
      </div>
      <div
        className="flex flex-wrap gap-x-3 gap-y-1 text-xs"
        data-testid="trace-frame-summary"
      >
        {frame ? (
          <>
            <SelectableText>
              Frame Index {index} / {max} · Tick {frame.tickIndex}
            </SelectableText>
            <SelectableText>
              Script {frame.scriptMs.toFixed(2)} ms · Physics{" "}
              {frame.physicsMs.toFixed(2)} ms · Tick Total{" "}
              {frameTickMs(frame).toFixed(2)} ms
            </SelectableText>
            <SelectableText
              className={
                frameTickMs(frame) > TICK_BUDGET_MS
                  ? "text-destructive"
                  : "text-muted-foreground"
              }
            >
              {frameTickMs(frame) > TICK_BUDGET_MS
                ? "Over Budget"
                : "Within Budget"}{" "}
              · {TICK_BUDGET_MS} ms
            </SelectableText>
          </>
        ) : (
          <span>No Recorded Frames</span>
        )}
      </div>
      {!frame && <TraceEmptyState title="No Recorded Frames" />}
      <div
        ref={chartRef}
        className="trace-timing-chart relative flex h-32 min-h-32 w-full items-end gap-px overflow-hidden"
        data-testid="trace-playback-graph"
        aria-label="Script And Physics Tick Times"
      >
        {buckets.map((bucket) => {
          const selected = index >= bucket.start && index <= bucket.end;
          const selectedFrame = payload.frames[index];
          const title = `Frames ${bucket.start}–${bucket.end} · Peak Tick ${payload.frames[bucket.peak]!.tickIndex} · Script ${bucket.scriptMs.toFixed(2)} ms · Physics ${bucket.physicsMs.toFixed(2)} ms${bucket.overBudget ? " · Over Budget" : ""}${bucket.hasEvents ? " · Recorded Events" : ""}`;
          return (
            <Button
              key={bucket.start}
              variant="ghost"
              className="trace-timing-bar relative h-full min-w-0 flex-1"
              style={{ flexGrow: bucket.end - bucket.start + 1 }}
              aria-label={title}
              title={title}
              aria-current={selected ? "true" : undefined}
              data-selected={selected ? "true" : "false"}
              data-over-budget={bucket.overBudget ? "true" : "false"}
              data-testid={`trace-playback-graph-bar-${bucket.start}`}
              onClick={() => onIndexChange(bucket.peak)}
            >
              <span
                className="trace-physics-segment absolute inset-x-0"
                style={{
                  bottom: `${(bucket.scriptMs / scale) * 100}%`,
                  height: `${(bucket.physicsMs / scale) * 100}%`,
                }}
              />
              <span
                className="trace-script-segment absolute inset-x-0 bottom-0 min-h-px"
                style={{ height: `${(bucket.scriptMs / scale) * 100}%` }}
              />
              {bucket.overBudget && (
                <span
                  className="absolute inset-x-0 top-0 h-1 bg-destructive"
                  aria-hidden="true"
                />
              )}
              {bucket.hasEvents && (
                <span
                  className="absolute bottom-0 left-1/2 size-1 -translate-x-1/2 rounded-full bg-foreground"
                  aria-hidden="true"
                />
              )}
              {selected && (
                <span className="sr-only">
                  Selected Tick {selectedFrame?.tickIndex}
                </span>
              )}
            </Button>
          );
        })}
        {frame && (
          <>
            <div
              data-testid="trace-budget-line"
              className="pointer-events-none absolute inset-x-0 border-t border-dashed border-destructive"
              style={{ bottom: `${(TICK_BUDGET_MS / scale) * 100}%` }}
            />
            <div
              data-testid="trace-selection-indicator"
              className="pointer-events-none absolute inset-y-0 w-0.5 bg-trace-selected"
              style={{
                left: `calc(${selectionFraction * 100}% + ${selectedBucketIndex - selectionFraction * (buckets.length - 1) - 1}px)`,
              }}
            />
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-2 bg-trace-script" />
          Script
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 bg-trace-physics" />
          Physics
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 bg-trace-selected" />
          Selected
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 bg-destructive" />
          Over Budget
        </span>
        <span>• Recorded Events</span>
        <SelectableText>Scale 0–{scale.toFixed(1)} ms</SelectableText>
      </div>
      <span data-testid="trace-visible-range">
        <SelectableText className="text-xs text-muted-foreground">
          {frame
            ? `Frames ${start}–${end}${buckets.some((bucket) => bucket.end > bucket.start) ? " · Group Peaks — Select A Bar To Inspect Its Slowest Tick" : " · One Bar Per Frame"}`
            : "No Frames"}
        </SelectableText>
      </span>
      <Field>
        <FieldLabel htmlFor={frameId}>Frame Index</FieldLabel>
        <div className="flex min-w-0 items-center gap-2">
          <Slider
            min={0}
            max={max}
            step={1}
            value={index}
            disabled={!frame || max === 0}
            aria-label="Frame"
            data-testid="trace-playback-scrubber"
            onValueChange={(value) => {
              const next = Array.isArray(value) ? value[0] : value;
              if (typeof next === "number") onIndexChange(next);
            }}
          />
          <div className="w-20 shrink-0">
            <NumberField
              id={frameId}
              value={index}
              min={0}
              max={max}
              inputMode="numeric"
              disabled={!frame}
              data-testid="trace-playback-frame"
              onChange={onIndexChange}
            />
          </div>
        </div>
      </Field>
    </div>
  );
}
