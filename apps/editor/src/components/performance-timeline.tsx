import { useMemo, useState } from "react";
import {
  TICK_BUDGET_MS,
  TICK_TIMING_PHASE_LABELS,
  TICK_TIMING_PHASES,
  type PerformanceProfile,
  type PerformanceStream,
  type TickTimingPhase,
} from "@haptic/debugger";
import {
  humanizePropertyLabel,
  NumberField,
  TimelineChart,
  ToolbarStrip,
  useTouchUi,
  WindowedList,
  WINDOWED_LIST_TOUCH_ROW_HEIGHT,
  type TimelineDomain,
  type TimelineSegment,
  type TimelineSelection,
  type TimelineTrack,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@haptic/ui/components/select";
import { Separator } from "@haptic/ui/components/separator";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { cn } from "@haptic/ui/lib/utils";
import { ChevronsLeftIcon, ChevronsRightIcon, XIcon } from "lucide-react";
import { Facts } from "./diagnostic-facts";
import { TraceEmptyState } from "./trace-inspection-controls";
import { accountedMemoryMiB, formatRecorded, frameBudget, linkedRow, profileMarkers, streamColumn, summarizeRange, tickTimes } from "../lib/performance-timeline-model";

type Population = "frames" | "ticks" | "gpu" | "memory";
/** A plotted part of a stream, with the recorded columns it sums. */
type ProfilerSegment = TimelineSegment & { columns: readonly string[] };
type ProfilerTrack = Omit<TimelineTrack, "id" | "segments"> & {
  id: Population;
  segments: readonly ProfilerSegment[];
  /** Recorded units per plotted unit, such as bytes per MiB; 1 when they match. */
  scale?: number;
};
/** What the Frames track plots, or which tick column replaces the stacked phases. */
type Metric = "frameTime" | "preparation" | "submission" | "drawCalls" | "script" | "physics";

const METRICS: readonly { value: Metric; label: string }[] = [
  { value: "frameTime", label: "Frame Time" },
  { value: "preparation", label: "Preparation" },
  { value: "submission", label: "Submission" },
  { value: "drawCalls", label: "Draw Calls" },
  { value: "script", label: "Script" },
  { value: "physics", label: "Physics" },
];
const FRAME_METRIC: Partial<Record<Metric, { column: string; label: string; unit: string }>> = {
  frameTime: { column: "intervalMs", label: "Frame Time", unit: "ms" },
  preparation: { column: "preparationMs", label: "Preparation", unit: "ms" },
  submission: { column: "submissionMs", label: "Submission", unit: "ms" },
  drawCalls: { column: "drawCalls", label: "Draw Calls", unit: "" },
};
/** Tick phase colours (`--tick-*` tokens), in tick order. */
const TICK_PHASE_COLOR: Readonly<Record<TickTimingPhase, string>> = {
  gameInstance: "--tick-game-instance",
  sceneSubsystems: "--tick-scene-subsystems",
  actors: "--tick-actors",
  components: "--tick-components",
  physics: "--tick-physics",
  postPhysics: "--tick-post-physics",
  sceneSystems: "--tick-scene-systems",
};
const COLOR_CLASS: Readonly<Record<string, string>> = {
  "--trace-script": "bg-trace-script",
  "--trace-physics": "bg-trace-physics",
  "--tick-game-instance": "bg-tick-game-instance",
  "--tick-scene-subsystems": "bg-tick-scene-subsystems",
  "--tick-actors": "bg-tick-actors",
  "--tick-components": "bg-tick-components",
  "--tick-physics": "bg-tick-physics",
  "--tick-post-physics": "bg-tick-post-physics",
  "--tick-scene-systems": "bg-tick-scene-systems",
};
const POPULATION_LABEL: Readonly<Record<Population, string>> = { frames: "Frames", ticks: "Ticks", gpu: "GPU", memory: "Memory" };
const isPopulation = (value: unknown): value is Population => typeof value === "string" && value in POPULATION_LABEL;

const formatTime = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
/** Sample number column, then one column per recorded value. */
const sampleColumns = (count: number) => `4rem repeat(${count}, minmax(5.5rem, 1fr))`;
const sampleCell = (value: number) => Number.isFinite(value)
  ? Number.isInteger(value) ? value : value.toFixed(3)
  : <span className="font-sans text-xs text-muted-foreground">Unavailable</span>;
const TD = "px-2 text-right font-mono text-[11px] tabular-nums";

function rowAt(stream: PerformanceStream, index: number): number[] {
  let offset = index * stream.columns.length;
  for (const chunk of stream.chunks) {
    if (offset < chunk.length) return Array.from(chunk.subarray(offset, offset + stream.columns.length));
    offset -= chunk.length;
  }
  return [];
}
const rowFacts = (stream: PerformanceStream, row: number) => {
  const values = rowAt(stream, row);
  return Object.fromEntries(stream.columns.map((column, offset) => [column, Number.isFinite(values[offset]) ? values[offset] : null]));
};

const segment = (stream: PerformanceStream, label: string, column: string, color: string): ProfilerSegment =>
  ({ label, columns: [column], color, values: streamColumn(stream, column) });

/** The ticks' stacked parts: every timed phase (version 2), else script and physics (version 1), or the one column the metric picks. */
function tickSegments(stream: PerformanceStream, metric: Metric): ProfilerSegment[] {
  if (metric === "script") return [segment(stream, "Script", "scriptMs", "--trace-script")];
  if (metric === "physics") return [segment(stream, "Physics", "physicsMs", "--tick-physics")];
  if (stream.columns.includes("actorsMs")) {
    return TICK_TIMING_PHASES.map((phase) => segment(stream, TICK_TIMING_PHASE_LABELS[phase], `${phase}Ms`, TICK_PHASE_COLOR[phase]));
  }
  return [segment(stream, "Script", "scriptMs", "--trace-script"), segment(stream, "Physics", "physicsMs", "--trace-physics")];
}

/**
 * Every recorded sample on one time axis: frames, ticks (stacked by phase), GPU queries, accounted
 * memory and markers (loading, scene changes and long tasks), each on its own scale. Ticks are placed on the frames' clock through the frames that present them.
 * Selecting a sample shows it with the frame or tick it belongs to; dragging selects a range and
 * summarizes it. The table lists one population's samples.
 */
export function PerformanceTimeline({ profile }: { profile: PerformanceProfile }) {
  const touch = useTouchUi();
  const [population, setPopulation] = useState<Population>("frames");
  const [selected, setSelected] = useState(0);
  const [metric, setMetric] = useState<Metric>("frameTime");
  const [range, setRange] = useState<TimelineDomain | null>(null);
  const budget = frameBudget(profile);

  const times = useMemo(() => ({
    frames: streamColumn(profile.frames, "completedAtMs"),
    ticks: tickTimes(profile),
    gpu: streamColumn(profile.gpu, "observedAtMs"),
    memory: streamColumn(profile.memory, "sampledAtMs"),
  }), [profile]);
  const frameMetric = FRAME_METRIC[metric] ?? FRAME_METRIC.frameTime!;
  const tracks = useMemo(() => {
    const list: ProfilerTrack[] = [{
      id: "frames", label: "Frames", times: times.frames, unit: frameMetric.unit,
      segments: [segment(profile.frames, frameMetric.label, frameMetric.column, "--trace-script")],
      ...(frameMetric.column === "intervalMs" ? { threshold: budget } : {}),
    }, {
      id: "ticks", label: "Ticks", times: times.ticks, unit: "ms",
      segments: tickSegments(profile.ticks, metric),
      ...(metric === "script" || metric === "physics" ? {} : { threshold: TICK_BUDGET_MS }),
    }];
    if (profile.gpu.count) {
      list.push({ id: "gpu", label: "GPU", times: times.gpu, unit: "ms",
        segments: [segment(profile.gpu, "GPU Duration", "durationMs", "--trace-script")] });
    }
    if (profile.memory.count) {
      list.push({ id: "memory", label: "Memory", times: times.memory, unit: "MiB", scale: 1024 * 1024,
        segments: [{ label: "Accounted", columns: ["textureBytes", "geometryBytes"], color: "--trace-script", values: accountedMemoryMiB(profile.memory) }] });
    }
    return list;
  }, [budget, frameMetric, metric, profile, times]);
  const markers = useMemo(() => profileMarkers(profile), [profile]);
  const domain = useMemo((): TimelineDomain => {
    let end = profile.durationMs;
    for (const values of Object.values(times)) {
      for (const time of values) if (Number.isFinite(time) && time > end) end = time;
    }
    return [0, Math.max(end, 1)];
  }, [profile.durationMs, times]);

  const stream = profile[population];
  const index = Math.max(0, Math.min(Number.isFinite(selected) ? Math.floor(selected) : 0, Math.max(0, stream.count - 1)));
  const tableTrack = tracks.find((track) => track.id === population);
  // Over budget follows the table's population, as its track measures it.
  const overBudget = useMemo(() => {
    const track = tracks.find((entry) => entry.id === population);
    if (!track || track.threshold === undefined) return [];
    const rows: number[] = [];
    for (let row = 0; row < track.times.length; row++) {
      let total = 0;
      for (const segment of track.segments) if (Number.isFinite(segment.values[row]!)) total += segment.values[row]!;
      if (total > track.threshold) rows.push(row);
    }
    return rows;
  }, [population, tracks]);
  const previousOver = overBudget.findLast((row) => row < index);
  const nextOver = overBudget.find((row) => row > index);
  const metricColumns = new Set(tableTrack?.segments.flatMap((part) => part.columns));
  const columns = sampleColumns(stream.columns.length);
  // Wide enough for every column, so the rows scroll sideways together with the header.
  const tableWidth = `calc(4rem + ${stream.columns.length} * 5.5rem)`;
  const rowHeight = touch ? WINDOWED_LIST_TOUCH_ROW_HEIGHT : 28;
  const overRows = new Set(overBudget);
  const select = (next: Population, row: number) => {
    setPopulation(next);
    setSelected(row);
  };
  const linked = population === "frames" ? linkedRow(profile.frames, profile.ticks, index)
    : population === "ticks" ? linkedRow(profile.ticks, profile.frames, index) : null;
  const chartSelection: TimelineSelection | null = stream.count ? { track: population, index } : null;
  const recorded = profile.frames.count + profile.ticks.count + profile.gpu.count;

  return <div className="flex h-full min-h-0 flex-col">
    <ToolbarStrip className="gap-2 py-0.5">
      <ToggleGroup value={[population]} onValueChange={(next) => {
        if (isPopulation(next[0])) select(next[0], 0);
      }} size="sm" variant="outline">
        <ToggleGroupItem value="frames">Completed Frames</ToggleGroupItem><ToggleGroupItem value="ticks">Runtime Ticks</ToggleGroupItem>
        {profile.gpu.count ? <ToggleGroupItem value="gpu">GPU Queries</ToggleGroupItem> : null}
        {profile.memory.count ? <ToggleGroupItem value="memory">Memory Samples</ToggleGroupItem> : null}
      </ToggleGroup>
      <Select value={metric} items={METRICS} onValueChange={(value) => { if (value) setMetric(value as Metric); }}>
        <SelectTrigger size="sm" aria-label="Metric" className="w-36" data-testid="performance-timeline-metric"><SelectValue /></SelectTrigger>
        <SelectContent>{METRICS.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}</SelectContent>
      </Select>
      {stream.count ? <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
        {tableTrack?.threshold !== undefined ? <>
          <span className={cn("tabular-nums", overBudget.length && "text-destructive")}>{overBudget.length} Over Budget</span>
          <Button variant="ghost" size="icon-sm" aria-label="Previous Over Budget" title="Previous Over Budget" className="pointer-coarse:size-11"
            disabled={previousOver === undefined} onClick={() => { if (previousOver !== undefined) setSelected(previousOver); }}><ChevronsLeftIcon /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next Over Budget" title="Next Over Budget" className="pointer-coarse:size-11"
            disabled={nextOver === undefined} onClick={() => { if (nextOver !== undefined) setSelected(nextOver); }}><ChevronsRightIcon /></Button>
          <Separator orientation="vertical" className="mx-1 h-4 self-center" />
        </> : null}
        <label htmlFor="diagnostic-sample-index">Sample</label>
        <div className="w-20"><NumberField id="diagnostic-sample-index" min={0} max={stream.count - 1} step={1} value={index} onChange={setSelected} /></div>
        <span className="tabular-nums">/ {stream.count - 1}</span>
      </div> : null}
    </ToolbarStrip>
    {recorded ? <>
      <TimelineChart
        tracks={tracks}
        markers={markers}
        domain={domain}
        selected={chartSelection}
        range={range}
        onSelect={({ track, index: row }) => { if (isPopulation(track)) select(track, row); }}
        onRangeChange={setRange}
        formatTime={formatTime}
        aria-label={`Performance timeline: ${profile.frames.count} frames, ${profile.ticks.count} ticks${profile.gpu.count ? `, ${profile.gpu.count} GPU queries` : ""}${profile.memory.count ? `, ${profile.memory.count} memory samples` : ""}`}
      />
      <TimelineLegend tracks={tracks} budget={budget} metric={metric}
        // Version 3 names what its host recorded; an earlier recording had no long tasks to report.
        longTasksUnreported={profile.version >= 3 && !profile.identity.enabledDiagnostics.includes("long-tasks")} />
      {range ? <RangeSummary profile={profile} tracks={tracks} times={times} range={range} onClear={() => setRange(null)} /> : null}
    </> : null}
    {stream.count ? <div className="flex min-h-64 flex-1 flex-col lg:flex-row">
      {/* Narrow layouts put the sample's details under the table instead of beside it. */}
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <div role="table" aria-label="Samples" aria-rowcount={stream.count + 1} className="text-xs" style={{ minWidth: tableWidth }}>
          <div role="row" className="sticky top-0 z-10 grid h-7 border-b bg-panel-header" style={{ gridTemplateColumns: columns }}>
            <div role="columnheader" className="flex items-center px-2 font-medium text-muted-foreground">Sample</div>
            {stream.columns.map((column) => <div role="columnheader" key={column} title={humanizePropertyLabel(column)}
              className={cn("flex min-w-0 items-center justify-end px-2 font-medium whitespace-nowrap text-muted-foreground", metricColumns.has(column) && "text-foreground")}>
              <span className="truncate">{humanizePropertyLabel(column)}</span>
            </div>)}
          </div>
          <WindowedList itemCount={stream.count} rowHeight={rowHeight} activeIndex={index}>
            {(row) => <div role="row" aria-rowindex={row + 2} aria-selected={row === index} style={{ gridTemplateColumns: columns }}
              className={cn("grid h-full items-center hover:bg-accent/50", row % 2 === 1 && "bg-list-stripe", row === index && "bg-accent hover:bg-accent")}>
              <div role="cell" className="h-full">
                <Button variant="ghost" size="xs" className="h-full w-full justify-start rounded-none font-mono text-[11px] tabular-nums" onClick={() => setSelected(row)}>{row}</Button>
              </div>
              {rowAt(stream, row).map((value, column) => <div role="cell" key={column}
                className={cn(TD, metricColumns.has(stream.columns[column]!) && overRows.has(row) && "text-destructive")}>
                {sampleCell(value)}
              </div>)}
            </div>}
          </WindowedList>
        </div>
      </div>
      <div className="max-h-48 shrink-0 overflow-auto border-t lg:max-h-none lg:w-72 lg:border-t-0 lg:border-l">
        <Facts title={`Sample ${index}`} aside={POPULATION_LABEL[population]} data={rowFacts(stream, index)} />
        {population === "frames" ? linked === null
          ? <p className="px-2 py-1.5 text-xs text-muted-foreground">The tick this frame presents was not recorded.</p>
          : <Facts title={`Tick ${linked}`} aside="Presented By This Frame" data={rowFacts(profile.ticks, linked)} />
          : population === "ticks" ? linked === null
            ? <p className="px-2 py-1.5 text-xs text-muted-foreground">No recorded frame presented this tick.</p>
            : <Facts title={`Frame ${linked}`} aside="First To Present It" data={rowFacts(profile.frames, linked)} />
            : null}
      </div>
    </div> : <TraceEmptyState title="No Samples" description="This population had no completed samples during the recording." />}
  </div>;
}

function TimelineLegend({ tracks, budget, metric, longTasksUnreported }: {
  tracks: readonly ProfilerTrack[];
  budget: number;
  metric: Metric;
  longTasksUnreported: boolean;
}) {
  const ticks = tracks.find((track) => track.id === "ticks")!;
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b px-2 py-1 text-[11px] text-muted-foreground">
    <span className="font-medium text-foreground">{ticks.segments.length > 2 ? "Tick Phases" : ticks.segments.length === 2 ? "Script + Physics" : METRICS.find((entry) => entry.value === metric)?.label}</span>
    {ticks.segments.length > 1 ? ticks.segments.map((segment) => <span key={segment.label} className="flex items-center gap-1">
      <span className={cn("size-2", COLOR_CLASS[segment.color])} />{segment.label}
    </span>) : null}
    <span className="flex items-center gap-1"><span className="size-2 bg-trace-selected" />Selected</span>
    <span className="flex items-center gap-1"><span className="w-3 border-t border-dashed border-destructive" />Budget {budget.toFixed(2)} ms per frame · {TICK_BUDGET_MS} ms per tick</span>
    <span className="ml-auto">
      Ticks are placed on the frames&apos; clock through the frames that present them.
      {longTasksUnreported ? " This browser does not report long tasks." : ""} Drag across the chart to summarize a range.
    </span>
  </div>;
}

function RangeSummary({ profile, tracks, times, range, onClear }: {
  profile: PerformanceProfile;
  tracks: readonly ProfilerTrack[];
  times: Readonly<Record<Population, ArrayLike<number>>>;
  range: TimelineDomain;
  onClear: () => void;
}) {
  return <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-2 py-1 text-xs" role="status" aria-label="Range Summary" data-testid="performance-range-summary">
    <span className="font-medium">{formatTime(range[0])} – {formatTime(range[1])}</span>
    {tracks.map((track) => {
      const summary = summarizeRange(profile[track.id], times[track.id], range, track.segments.flatMap((part) => part.columns), track.threshold);
      const unit = track.unit ? ` ${track.unit}` : "";
      const shown = (value: number | null) => formatRecorded(value == null ? value : value / (track.scale ?? 1));
      return <span key={track.id} className="text-muted-foreground">
        <span className="text-foreground">{track.label}</span> {summary.count} · Median {shown(summary.median)}{unit} · p95 {shown(summary.p95)}{unit} · Max {shown(summary.maximum)}{unit}
        {summary.overBudgetCount ? <span className="text-destructive"> · {summary.overBudgetCount} Over Budget</span> : null}
      </span>;
    })}
    <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}><XIcon data-icon="inline-start" />Clear Range</Button>
  </div>;
}

