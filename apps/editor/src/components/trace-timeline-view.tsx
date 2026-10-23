import { useId, useMemo } from "react";
import type { TracePayload } from "@haptic/debugger";
import { TICK_BUDGET_MS } from "@haptic/debugger";
import { NumberField, SelectableText, TimelineChart, type TimelineMarker, type TimelineTrack } from "@haptic/editor-kit";
import { Badge } from "@haptic/ui/components/badge";
import { Button } from "@haptic/ui/components/button";
import { FieldLabel } from "@haptic/ui/components/field";
import { Separator } from "@haptic/ui/components/separator";
import { Slider } from "@haptic/ui/components/slider";
import { cn } from "@haptic/ui/lib/utils";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { frameTickMs, traceRetentionSummary } from "../lib/trace-view";
import { TraceEmptyState } from "./trace-inspection-controls";
import { useTraceTouch } from "../lib/use-trace-touch";

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
  const touch = useTraceTouch();
  const size = touch ? "touch-icon" : "icon-sm";
  const length = payload.frames.length;
  const max = Math.max(0, length - 1);
  const frame = payload.frames[index];
  const tickMs = frame ? frameTickMs(frame) : 0;
  const overBudget = tickMs > TICK_BUDGET_MS;
  const count = Math.min(length, windowSize ?? length);
  const start = Math.max(
    0,
    Math.min(length - count, index - Math.floor(count / 2)),
  );
  const end = start + count - 1;
  const { tracks, markers } = useMemo(() => traceTimeline(payload), [payload]);
  const frameLabel = (position: number) => {
    const at = Math.min(end, Math.max(start, Math.round(position)));
    return `Frame ${at} · Tick ${payload.frames[at]?.tickIndex ?? "?"}`;
  };
  const budgetTicks = useMemo(
    () =>
      payload.frames.flatMap((entry, i) =>
        frameTickMs(entry) > TICK_BUDGET_MS ? [i] : [],
      ),
    [payload],
  );
  const previousSpike = budgetTicks.findLast((i) => i < index);
  const nextSpike = budgetTicks.find((i) => i > index);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2"
      data-testid="trace-playback"
    >
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size={size}
          aria-label="Previous Frame"
          title="Previous Frame"
          disabled={!frame || index === 0}
          onClick={() => onIndexChange(index - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          variant="ghost"
          size={size}
          aria-label="Next Frame"
          title="Next Frame"
          disabled={!frame || index === max}
          onClick={() => onIndexChange(index + 1)}
        >
          <ChevronRightIcon />
        </Button>
        <Separator orientation="vertical" className="mx-0.5 h-4 self-center" />
        <Button
          variant="ghost"
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
          variant="ghost"
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
        <Separator orientation="vertical" className="mx-0.5 h-4 self-center" />
        <Button
          variant="ghost"
          size={size}
          aria-label="Zoom In"
          title="Zoom In Around Selected Frame"
          disabled={count <= 1}
          onClick={() => onWindowSizeChange(Math.max(1, Math.ceil(count / 2)))}
        >
          <ZoomInIcon />
        </Button>
        <Button
          variant="ghost"
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
          variant="ghost"
          size={touch ? "touch" : "sm"}
          disabled={windowSize === null}
          onClick={() => onWindowSizeChange(null)}
        >
          Show All Frames
        </Button>
        <div className="ml-auto flex min-w-0 flex-wrap justify-end gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span data-testid="trace-playback-seed">
            <SelectableText>Seed {payload.seed}</SelectableText>
          </span>
          <span data-testid="trace-playback-frames">
            <SelectableText>
              {length} Frames · Fixed Delta {payload.dt.toFixed(4)} s
            </SelectableText>
          </span>
          <span data-testid="trace-retention-summary">
            <SelectableText>{traceRetentionSummary(payload)}</SelectableText>
          </span>
        </div>
      </div>
      <div
        className="flex flex-wrap items-center gap-1.5 text-xs"
        data-testid="trace-frame-summary"
      >
        {frame ? (
          <>
            <span className="rounded-md bg-muted px-2 py-0.5 tabular-nums">
              <SelectableText>
                Frame Index <span className="font-medium">{index}</span> / {max} · Tick{" "}
                <span className="font-medium">{frame.tickIndex}</span>
              </SelectableText>
            </span>
            <span className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 tabular-nums">
              <span className="size-2 rounded-[2px] bg-trace-script" aria-hidden="true" />
              <SelectableText>Script {frame.scriptMs.toFixed(2)} ms</SelectableText>
            </span>
            <span className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 tabular-nums">
              <span className="size-2 rounded-[2px] bg-trace-physics" aria-hidden="true" />
              <SelectableText>Physics {frame.physicsMs.toFixed(2)} ms</SelectableText>
            </span>
            <span className="rounded-md bg-muted px-2 py-0.5 font-medium tabular-nums">
              <SelectableText>Tick Total {tickMs.toFixed(2)} ms</SelectableText>
            </span>
            {frame.publishMs !== undefined ? (
              <span className="rounded-md bg-muted px-2 py-0.5 tabular-nums" data-testid="trace-frame-publish">
                <SelectableText>Publish {frame.publishMs.toFixed(2)} ms</SelectableText>
              </span>
            ) : null}
            <Badge
              variant={overBudget ? "destructive" : "outline"}
              className={cn(!overBudget && "text-(--success)")}
            >
              {overBudget ? "Over Budget" : "Within Budget"} · {TICK_BUDGET_MS} ms
            </Badge>
          </>
        ) : (
          <span>No Recorded Frames</span>
        )}
      </div>
      {!frame && <TraceEmptyState title="No Recorded Frames" />}
      {frame ? (
        <div className="shrink-0 overflow-hidden rounded-md border" data-testid="trace-playback-graph">
          <TimelineChart
            tracks={tracks}
            markers={markers}
            domain={[start - 0.5, end + 0.5]}
            selected={{ track: "ticks", index }}
            onSelect={(selection) => onIndexChange(selection.index)}
            formatTime={frameLabel}
            trackHeight={TRACE_TRACK_PX}
            aria-label="Script And Physics Tick Times"
            className="border-b-0"
          />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.7rem] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-[2px] bg-trace-script" />
          Script
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-[2px] bg-trace-physics" />
          Physics
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-[2px] bg-trace-selected" />
          Selected
        </span>
        <span className="flex items-center gap-1">
          <span className="h-0.5 w-2 bg-destructive" />
          Over Budget · {TICK_BUDGET_MS} ms
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-0.5 bg-foreground" />
          Logs, Prints And Input
        </span>
        <span data-testid="trace-visible-range" className="ml-auto">
          <SelectableText>
            {frame ? `Frames ${start}–${end} · Each Bar Is The Slowest Tick It Covers` : "No Frames"}
          </SelectableText>
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <FieldLabel htmlFor={frameId} className="shrink-0 text-xs text-muted-foreground">
          Frame Index
        </FieldLabel>
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
    </div>
  );
}

/** The Ticks track is the Trace timeline's main view, so it stands taller than a Profiler track. */
const TRACE_TRACK_PX = 112;

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

/** One Ticks track (script and physics, stacked, against the tick budget) on a frame-index axis, and a marker for each frame that recorded logs, prints or input. */
function traceTimeline(payload: TracePayload): { tracks: TimelineTrack[]; markers: TimelineMarker[] } {
  const frames = payload.frames;
  const times = frames.map((_, index) => index);
  const tracks: TimelineTrack[] = [{
    id: "ticks",
    label: "Ticks",
    unit: "ms",
    times,
    threshold: TICK_BUDGET_MS,
    segments: [
      { label: "Script", color: "--trace-script", values: frames.map((frame) => Math.max(0, frame.scriptMs)) },
      { label: "Physics", color: "--trace-physics", values: frames.map((frame) => Math.max(0, frame.physicsMs)) },
    ],
  }];
  const markers: TimelineMarker[] = [];
  frames.forEach((frame, index) => {
    const parts = [
      frame.logs.length ? plural(frame.logs.length, "Log") : "",
      frame.prints.length ? plural(frame.prints.length, "Print") : "",
      frame.inputEvents?.length ? plural(frame.inputEvents.length, "Input") : "",
    ].filter(Boolean);
    if (parts.length) markers.push({ atMs: index, label: parts.join(" · "), color: "--foreground" });
  });
  return { tracks, markers };
}
