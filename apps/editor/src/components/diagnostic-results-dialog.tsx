import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { parsePerformanceProfile, serializePerformanceProfile, summarizePerformanceColumn, summarizePerformanceColumns, type PerformanceProfile, type PerformanceStream } from "@babylonslate/debugger";
import type { RenderFrameReport } from "@babylonslate/render";
import { humanizePropertyLabel, NumberField, PanelFrame, PropertySectionTitle, SearchInput, SelectableText, ToolbarStrip } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@babylonslate/ui/components/dialog";
import { Separator } from "@babylonslate/ui/components/separator";
import { cn } from "@babylonslate/ui/lib/utils";
import { CameraIcon, ChevronLeftIcon, ChevronRightIcon, ChevronsLeftIcon, ChevronsRightIcon, CircleIcon, CopyIcon, DownloadIcon, FolderOpenIcon, SquareIcon, XIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@babylonslate/ui/components/toggle-group";
import { useAppSettings } from "../context/app-settings-context";
import { profileDefaultsFromSettings } from "../lib/play-debugger-defaults";
import { DiagnosticResultsStore, type DiagnosticResult } from "../services/diagnostic-results-store";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@babylonslate/ui/components/empty";
import { TraceEmptyState } from "./trace-inspection-controls";

const format = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "Unavailable" : value.toFixed(3);
const factValue = (value: unknown) => value == null ? "Unavailable" : typeof value === "string" ? value : JSON.stringify(value);

/** Read-only recorded values as selectable label/value rows rather than disabled inputs. */
function Facts({ title, aside, data, columns = 1 }: { title: string; aside?: string; data: Record<string, unknown>; columns?: 1 | 3 }) {
  return <section className="flex min-w-0 flex-col" aria-label={title}>
    <PropertySectionTitle aside={aside ? <span className="font-normal text-muted-foreground">{aside}</span> : undefined}>{title}</PropertySectionTitle>
    <dl className={cn("grid text-xs", columns === 3 && "md:grid-cols-3")}>
      {Object.entries(data).map(([id, value], index) => <div key={id} className={cn("flex min-h-7 min-w-0 items-baseline gap-2 px-2 py-1", (columns === 1 ? index % 2 : Math.floor(index / 3) % 2) && "bg-list-stripe")}>
        <dt className="w-32 shrink-0 truncate text-muted-foreground">{humanizePropertyLabel(id)}</dt>
        <dd className={cn("min-w-0 flex-1 font-mono text-[11px] break-all", value == null && "font-sans text-xs text-muted-foreground")}><SelectableText>{factValue(value)}</SelectableText></dd>
      </div>)}
    </dl>
  </section>;
}
function rowAt(stream: PerformanceStream, index: number): number[] {
  let offset = index * stream.columns.length;
  for (const chunk of stream.chunks) {
    if (offset < chunk.length) return Array.from(chunk.subarray(offset, offset + stream.columns.length));
    offset -= chunk.length;
  }
  return [];
}
/** Per-row sum of the named columns; NaN where any column is unavailable. */
function columnSeries(stream: PerformanceStream, columns: readonly string[]): Float64Array {
  const offsets = columns.map(column => stream.columns.indexOf(column)).filter(offset => offset >= 0);
  const width = stream.columns.length;
  const series = new Float64Array(stream.count);
  let row = 0;
  for (const chunk of stream.chunks) {
    for (let base = 0; base + width <= chunk.length && row < stream.count; base += width, row++) {
      let sum = 0;
      for (const offset of offsets) sum += chunk[base + offset]!;
      series[row] = offsets.length ? sum : NaN;
    }
  }
  return series;
}
type Segment = { label: string; column: string; className: string };
const STREAM_METRIC: Record<"frames" | "ticks" | "gpu", { label: string; segments: Segment[] }> = {
  frames: { label: "Frame Interval", segments: [{ label: "Interval", column: "intervalMs", className: "bg-trace-script" }] },
  ticks: { label: "Script + Physics", segments: [
    { label: "Script", column: "scriptMs", className: "bg-trace-script" },
    { label: "Physics", column: "physicsMs", className: "bg-trace-physics" },
  ] },
  gpu: { label: "GPU Duration", segments: [{ label: "GPU", column: "durationMs", className: "bg-trace-script" }] },
};
const TABLE = "w-full border-collapse text-left text-xs";
const TH = "sticky top-0 z-10 h-7 border-b bg-panel-header px-2 font-medium whitespace-nowrap text-muted-foreground";
const TR = "h-7 even:bg-list-stripe hover:bg-accent/50";
const TD = "px-2 text-right font-mono text-[11px] tabular-nums";
const percent = (part: number, whole: number) => whole ? `${(part / whole * 100).toFixed(1)}%` : "0.0%";
const frameBudget = (profile: PerformanceProfile) => profile.identity.frameCap && profile.identity.frameCap > 0 ? 1000 / profile.identity.frameCap : 1000 / 60;

/** Bucketed stacked bars over one stream; each bar selects its slowest sample. */
function SampleChart({ segments, series, selected, threshold, onSelect }: {
  segments: readonly Segment[]; series: readonly Float64Array[]; selected: number; threshold?: number; onSelect: (index: number) => void;
}) {
  const length = series[0]?.length ?? 0;
  const total = (index: number) => series.reduce((sum, values) => sum + (Number.isFinite(values[index]) ? values[index]! : 0), 0);
  const buckets = useMemo(() => {
    const count = Math.min(240, length);
    return Array.from({ length: count }, (_, bucket) => {
      const start = Math.floor(bucket * length / count);
      const end = Math.max(start, Math.floor((bucket + 1) * length / count) - 1);
      let peak = start;
      for (let index = start; index <= end; index++) if (total(index) > total(peak)) peak = index;
      return { start, end, peak, value: total(peak) };
    });
    // total reads series only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, length]);
  const peak = Math.max(0, ...buckets.map(bucket => bucket.value));
  const scale = Math.max(threshold ?? 0, peak) * 1.1 || 1;
  const axis = (value: number) => `${value / scale * 100}%`;
  return <div className="flex h-28 border-b bg-background" data-testid="diagnostic-sample-chart">
    <div className="relative w-14 shrink-0 border-r text-right font-mono text-[10px] text-muted-foreground tabular-nums" aria-hidden="true">
      <span className="absolute right-1.5 translate-y-1/2" style={{ bottom: axis(peak) }}>{peak.toFixed(1)}</span>
      {threshold !== undefined ? <span className="absolute right-1.5 translate-y-1/2 text-destructive" style={{ bottom: axis(threshold) }}>{threshold.toFixed(1)}</span> : null}
      <span className="absolute right-1.5 bottom-0">0 ms</span>
    </div>
    <div className="relative flex min-w-0 flex-1 items-end gap-px px-1 pt-1">
      <div className="pointer-events-none absolute inset-x-0 border-t border-border/60" style={{ bottom: axis(peak) }} />
      {buckets.map(bucket => {
        const active = selected >= bucket.start && selected <= bucket.end;
        const over = threshold !== undefined && bucket.value > threshold;
        const parts = segments.map((segment, index) => `${segment.label} ${format(series[index]![bucket.peak])} ms`).join(" · ");
        const title = `${bucket.start === bucket.end ? `Sample ${bucket.start}` : `Samples ${bucket.start}–${bucket.end}, slowest ${bucket.peak}`} · ${segments.length > 1 ? `${parts} · ` : ""}Total ${format(bucket.value)} ms${over ? " · Over Budget" : ""}`;
        return <Button key={bucket.start} variant="ghost" aria-label={title} title={title} aria-current={active ? "true" : undefined} onClick={() => onSelect(bucket.peak)}
          className="relative h-full min-w-0 flex-1 flex-col-reverse items-stretch justify-start gap-0 rounded-none border-0 p-0 hover:bg-accent/60">
          {segments.map((segment, index) => {
            const value = series[index]![bucket.peak]!;
            return <span key={segment.column} className={cn("block w-full shrink-0", active ? "bg-trace-selected" : segment.className, !active && index > 0 && "opacity-90")}
              style={{ height: Number.isFinite(value) ? `max(1px, ${value / scale * 100}%)` : 0 }} />;
          })}
          {over && !active ? <span className="absolute inset-x-0 bg-destructive" style={{ bottom: axis(threshold!), height: `${(bucket.value - threshold!) / scale * 100}%` }} aria-hidden="true" /> : null}
        </Button>;
      })}
      {threshold !== undefined ? <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-destructive/80" style={{ bottom: axis(threshold) }} /> : null}
    </div>
  </div>;
}

/** Median → p95 bar with a whisker to the maximum on a shared millisecond scale. */
function DistributionBar({ values, scale, budget }: { values: { median: number | null; p95: number | null; maximum: number | null }; scale: number; budget?: number }) {
  if (values.median == null || values.p95 == null || values.maximum == null) return null;
  const x = (value: number) => `${Math.min(100, value / scale * 100)}%`;
  const over = budget !== undefined && values.p95 > budget;
  return <div className="relative h-3 w-full" aria-hidden="true">
    <span className="absolute top-1/2 h-px bg-muted-foreground/50" style={{ left: x(values.p95), width: `calc(${x(values.maximum)} - ${x(values.p95)})` }} />
    <span className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-muted-foreground/70" style={{ left: x(values.maximum) }} />
    <span className={cn("absolute top-0.5 bottom-0.5 left-0 bg-trace-script/35")} style={{ width: x(values.p95) }} />
    <span className={cn("absolute top-0.5 bottom-0.5 left-0", over ? "bg-destructive/80" : "bg-trace-script")} style={{ width: x(values.median) }} />
    {budget !== undefined ? <span className="absolute -top-0.5 -bottom-0.5 w-px bg-destructive" style={{ left: x(budget) }} /> : null}
  </div>;
}

function serializeResult(result: DiagnosticResult) {
  return result.kind === "profile" ? serializePerformanceProfile(result.profile) : JSON.stringify({ kind: "babylonslate-frame", version: 1, report: result.report });
}

type SummaryRow = readonly [label: string, values: ReturnType<typeof summarizePerformanceColumn>, budget?: number];
const COLUMN_HELP: Record<string, string> = {
  Count: "Samples with a finite measurement",
  Median: "Half of the samples took this long or less",
  p95: "95% of the samples took this long or less",
  p99: "99% of the samples took this long or less",
  Maximum: "Slowest sample",
  "Over Budget": "Samples slower than the threshold",
  Distribution: "Bar: median, light bar: p95, whisker: maximum, red line: threshold",
};

/** Leaf content also fits an ordinary DockView PanelFrame; no document asset or independent log. */
export function PerformanceSummary({ profile }: { profile: PerformanceProfile }) {
  const budget = frameBudget(profile);
  const gpu = profile.identity.gpuTiming === "unpaired";
  const groups = useMemo(() => [
    { title: "Main Thread", unit: "per completed frame", rows: [
      ["Completed Game-Frame Interval", summarizePerformanceColumn(profile.frames, "intervalMs", budget), budget],
      ["Main Preparation Wall Time", summarizePerformanceColumn(profile.frames, "preparationMs")],
      ["Main Submission Wall Time", summarizePerformanceColumn(profile.frames, "submissionMs")],
      ["Presentation/Copy Wall Time", summarizePerformanceColumn(profile.frames, "copyMs")],
    ] as SummaryRow[] },
    { title: "Worker", unit: "per runtime tick", rows: [
      ["Worker Script and Physics", summarizePerformanceColumns(profile.ticks, ["scriptMs", "physicsMs"], 8), 8],
      ["Worker Script Phase", summarizePerformanceColumn(profile.ticks, "scriptMs")],
      ["Worker Physics Phase", summarizePerformanceColumn(profile.ticks, "physicsMs")],
      ["Worker Snapshot Publish", summarizePerformanceColumn(profile.ticks, "publishMs")],
      ["Other Measured Runtime Phase", summarizePerformanceColumn(profile.ticks, "otherMs")],
    ] as SummaryRow[] },
    ...(gpu ? [{ title: "GPU", unit: "engine aggregate, not aligned to frames", rows: [
      ["GPU Time (Engine Aggregate)", summarizePerformanceColumn(profile.gpu, "durationMs")],
    ] as SummaryRow[] }] : []),
  ], [profile, budget, gpu]);
  const frame = groups[0]!.rows[0]![1];
  const worker = groups[1]!.rows[0]![1];
  return <div className="flex flex-col">
    <PropertySectionTitle aside={<span className="font-normal text-muted-foreground"><SelectableText>{profile.frames.count} completed frame samples · {profile.ticks.count} runtime tick samples · {(profile.durationMs / 1000).toFixed(2)} s · stopped: {profile.stopReason}</SelectableText></span>}>
      Result
    </PropertySectionTitle>
    <dl className="grid text-xs">
      {[
        { label: "Frame Pacing", over: frame.overBudgetCount ?? 0, text: frame.median == null ? "No completed frame intervals." : <>Median <b className="font-mono text-[11px] font-medium">{format(frame.median)} ms</b> ({(1000 / frame.median).toFixed(1)} FPS) · <span className={cn((frame.overBudgetCount ?? 0) && "text-destructive")}>{frame.overBudgetCount ?? 0} of {frame.count} frames ({percent(frame.overBudgetCount ?? 0, frame.count)})</span> slower than {budget.toFixed(2)} ms</> },
        { label: "Worker Tick", over: worker.overBudgetCount ?? 0, text: worker.median == null ? "No runtime ticks." : <>Median <b className="font-mono text-[11px] font-medium">{format(worker.median)} ms</b> script and physics · <span className={cn((worker.overBudgetCount ?? 0) && "text-destructive")}>{worker.overBudgetCount ?? 0} of {worker.count} ticks ({percent(worker.overBudgetCount ?? 0, worker.count)})</span> slower than 8 ms</> },
      ].map((row, index) => <div key={row.label} className={cn("flex min-h-7 items-center gap-2 px-2 py-1", index % 2 && "bg-list-stripe")}>
        <span className={cn("size-2 shrink-0 rounded-full", row.over ? "bg-destructive" : "bg-(--success)")} aria-hidden="true" />
        <dt className="w-28 shrink-0 text-muted-foreground">{row.label}</dt><dd>{row.text}</dd>
      </div>)}
    </dl>
    <div className="overflow-x-auto"><table className={TABLE}>
      <caption className="caption-bottom px-2 py-1.5 text-left text-xs text-muted-foreground">Durations in milliseconds. Frame and tick populations are independent.</caption>
      <thead><tr>{["Population", "Count", "Median", "p95", "p99", "Maximum", "Over Budget", "Distribution"].map((label, index) => <th key={label} title={COLUMN_HELP[label]} className={cn(TH, index && index < 7 && "text-right", label === "Distribution" && "w-[22%]")}>{label}</th>)}</tr></thead>
      {groups.map(group => {
        const scale = Math.max(...group.rows.map(([, values, rowBudget]) => Math.max(values.maximum ?? 0, rowBudget ?? 0))) * 1.05 || 1;
        return <tbody key={group.title}>
          <tr className="h-7 border-b bg-panel-header/60"><th colSpan={7} className="px-2 text-left font-medium">{group.title} <span className="font-normal text-muted-foreground">· {group.unit}</span></th>
            <td className="px-2 text-right font-mono text-[10px] text-muted-foreground">0 – {(scale / 1.05).toFixed(1)} ms</td></tr>
          {group.rows.map(([label, values, rowBudget], index) => <tr key={label} className={TR}>
            <th className={cn("px-2 font-normal whitespace-nowrap", index > 0 && "pl-6 text-muted-foreground")}>{label}</th>
            <td className={cn(TD, "text-muted-foreground")}>{values.count}</td>{[values.median, values.p95, values.p99, values.maximum].map((value, column) => <td key={column} className={cn(TD, rowBudget !== undefined && value != null && value > rowBudget && "text-destructive")}>{format(value)}</td>)}
            <td className={cn(TD, values.overBudgetCount ? "text-destructive" : "text-muted-foreground", values.overBudgetCount == null && "font-sans text-xs")}>{values.overBudgetCount == null ? "No threshold" : <>{values.overBudgetCount}<span className="text-muted-foreground"> · {percent(values.overBudgetCount, values.count)}</span></>}</td>
            <td className="px-2"><DistributionBar values={values} scale={scale} budget={rowBudget} /></td></tr>)}
        </tbody>;
      })}
    </table></div>
    <PropertySectionTitle>Notes</PropertySectionTitle>
    <div className="flex flex-col gap-1 px-2 py-1.5 text-xs text-muted-foreground">
      <p>Frame threshold {budget.toFixed(2)} ms. Combined Worker script and physics threshold 8 ms per tick. Submission includes driver waits; asynchronous copy latency can overlap submission. Concurrent host and Worker durations are not summed.</p>
      <p>GPU timing: {gpu ? `${profile.gpu.count} engine-aggregate query results, not aligned to frames` : profile.identity.gpuReason ?? profile.identity.gpuTiming}. Heap and physical VRAM: unavailable. These captures contain timing records and no world snapshots.</p>
      <p>Retained {(profile.retainedBytes / 1048576).toFixed(2)} MiB / {(profile.byteBudget / 1048576).toFixed(0)} MiB budget; {profile.droppedRecords} dropped records. Accounted buffers are not a browser heap limit.</p>
    </div>
    <Facts title="Session" data={profile.identity} columns={3} />
  </div>;
}

export function PerformanceTimeline({ profile }: { profile: PerformanceProfile }) {
  const [population, setPopulation] = useState<keyof typeof STREAM_METRIC>("frames");
  const [selected, setSelected] = useState(0);
  const stream = profile[population];
  const metric = STREAM_METRIC[population];
  const index = Math.max(0, Math.min(Number.isFinite(selected) ? Math.floor(selected) : 0, Math.max(0, stream.count - 1)));
  const page = Math.floor(index / 100) * 100;
  const indices = Array.from({ length: Math.min(100, Math.max(0, stream.count - page)) }, (_, offset) => page + offset);
  const values = rowAt(stream, index);
  const series = useMemo(() => metric.segments.map(segment => columnSeries(stream, [segment.column])), [stream, metric]);
  const threshold = population === "frames" ? frameBudget(profile) : population === "ticks" ? 8 : undefined;
  const totalAt = (row: number) => series.reduce((sum, values) => sum + (Number.isFinite(values[row]) ? values[row]! : 0), 0);
  const overBudget = useMemo(() => threshold === undefined ? [] : Array.from({ length: stream.count }, (_, row) => row).filter(row => totalAt(row) > threshold),
    // totalAt reads series only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, threshold, stream.count]);
  const previousOver = overBudget.findLast(row => row < index);
  const nextOver = overBudget.find(row => row > index);
  const metricColumns = new Set(metric.segments.map(segment => segment.column));
  const tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => { tableRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [index, population]);
  return <div className="flex h-full min-h-0 flex-col">
    <ToolbarStrip className="gap-2 py-0.5">
      <ToggleGroup value={[population]} onValueChange={next => { if (next[0] === "frames" || next[0] === "ticks" || next[0] === "gpu") { setPopulation(next[0]); setSelected(0); } }} size="sm" variant="outline">
        <ToggleGroupItem value="frames">Completed Frames</ToggleGroupItem><ToggleGroupItem value="ticks">Runtime Ticks</ToggleGroupItem>
        {profile.gpu.count ? <ToggleGroupItem value="gpu">GPU Queries</ToggleGroupItem> : null}
      </ToggleGroup>
      {stream.count ? <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
        {threshold !== undefined ? <>
          <span className={cn("tabular-nums", overBudget.length && "text-destructive")}>{overBudget.length} Over Budget</span>
          <Button variant="ghost" size="icon-sm" aria-label="Previous Over Budget" title="Previous Over Budget" className="pointer-coarse:size-11" disabled={previousOver === undefined} onClick={() => { if (previousOver !== undefined) setSelected(previousOver); }}><ChevronsLeftIcon /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="Next Over Budget" title="Next Over Budget" className="pointer-coarse:size-11" disabled={nextOver === undefined} onClick={() => { if (nextOver !== undefined) setSelected(nextOver); }}><ChevronsRightIcon /></Button>
          <Separator orientation="vertical" className="mx-1 h-4 self-center" />
        </> : null}
        <label htmlFor="diagnostic-sample-index">Sample</label>
        <div className="w-20"><NumberField id="diagnostic-sample-index" min={0} max={stream.count - 1} step={1} value={index} onChange={setSelected} /></div>
        <span className="tabular-nums">/ {stream.count - 1}</span>
        <Button variant="ghost" size="icon-sm" aria-label="Previous 100" title="Previous 100" className="pointer-coarse:size-11" disabled={!index} onClick={() => setSelected(Math.max(0, page - 100))}><ChevronLeftIcon /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next 100" title="Next 100" className="pointer-coarse:size-11" disabled={page + 100 >= stream.count} onClick={() => setSelected(page + 100)}><ChevronRightIcon /></Button>
      </div> : null}
    </ToolbarStrip>
    {stream.count ? <>
      <SampleChart segments={metric.segments} series={series} selected={index} threshold={threshold} onSelect={setSelected} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b px-2 py-1 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">{metric.label}</span>
        {metric.segments.length > 1 ? metric.segments.map(segment => <span key={segment.column} className="flex items-center gap-1"><span className={cn("size-2", segment.className)} />{segment.label}</span>) : null}
        <span className="flex items-center gap-1"><span className="size-2 bg-trace-selected" />Selected</span>
        {threshold !== undefined ? <span className="flex items-center gap-1"><span className="w-3 border-t border-dashed border-destructive" />Budget {threshold.toFixed(2)} ms</span> : null}
        <span className="ml-auto">Each stream uses its own recording-relative clock. Rows are not aligned by host/Worker timestamps. Loading samples are explicitly marked.</span>
      </div>
      <div className="flex min-h-64 flex-1">
        <div ref={tableRef} className="min-w-0 flex-1 overflow-auto"><table className={TABLE}><thead><tr><th className={TH}>Sample</th>{stream.columns.map(column => <th className={cn(TH, "text-right", metricColumns.has(column) && "text-foreground")} key={column}>{humanizePropertyLabel(column)}</th>)}</tr></thead>
          <tbody>{indices.map(row => <tr key={row} aria-selected={row === index} className={cn(TR, row === index && "bg-accent even:bg-accent hover:bg-accent")}>
            <td className="p-0"><Button variant="ghost" size="xs" className="h-7 w-full justify-start rounded-none font-mono text-[11px] tabular-nums pointer-coarse:min-h-11" onClick={() => setSelected(row)}>{row}</Button></td>
            {rowAt(stream, row).map((value, column) => <td className={cn(TD, metricColumns.has(stream.columns[column]!) && threshold !== undefined && totalAt(row) > threshold && "text-destructive")} key={column}>{Number.isFinite(value) ? Number.isInteger(value) ? value : value.toFixed(3) : <span className="font-sans text-xs text-muted-foreground">Unavailable</span>}</td>)}</tr>)}</tbody></table></div>
        <div className="hidden w-72 shrink-0 overflow-auto border-l lg:block">
          <Facts title={`Sample ${index}`} data={Object.fromEntries(stream.columns.map((column, offset) => [column, Number.isFinite(values[offset]) ? values[offset] : null]))} />
        </div>
      </div>
    </> : <TraceEmptyState title="No Samples" description="This population had no completed samples during the recording." />}
  </div>;
}

const STAGE_KIND_CLASS: Record<string, string> = {
  task: "bg-trace-script", frameGraph: "bg-trace-physics", native: "bg-trace-physics",
  overlay: "bg-muted-foreground/60", composition: "bg-muted-foreground/60", auxiliary: "bg-muted-foreground/60",
};
const resourceText = (resource: RenderFrameReport["resources"][number]) => [
  resource.labels?.join(", ") || `Handle ${resource.handle}`,
  resource.width && resource.height ? `${resource.width} × ${resource.height}` : null,
  resource.samples && resource.samples > 1 ? `${resource.samples}× MSAA` : null,
  resource.unavailable ? `Unavailable: ${resource.unavailable}` : null,
].filter(Boolean).join(" · ");

export function FrameReportView({ report }: { report: RenderFrameReport }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const stages = report.stages.filter(stage => `${stage.name} ${stage.kind}`.toLowerCase().includes(query.toLowerCase()));
  const stage = report.stages.find(entry => entry.id === selected);
  const task = stage?.taskId == null ? undefined : report.tasks.find(entry => entry.id === stage.taskId && entry.graphId === stage.graphId);
  const handles = new Set(task?.passes.flatMap(pass => [...(pass.colorTargets ?? []), ...(pass.depthTarget == null ? [] : [pass.depthTarget])]) ?? []);
  const resources = stage ? report.resources.filter(resource => resource.graphId === stage.graphId && handles.has(resource.handle)) : [];
  const origin = Math.min(...report.stages.map(entry => entry.startedAtMs));
  const span = Math.max(0.001, ...report.stages.map(entry => entry.startedAtMs - origin + (entry.submissionMs ?? 0)));
  const depth = (entry: (typeof report.stages)[number]) => {
    let level = 0;
    for (let parent = entry.parentId; parent != null && level < 8; level++) parent = report.stages.find(other => other.id === parent)?.parentId;
    return level;
  };
  const stageForTask = (taskId: number, graphId: number) => report.stages.find(entry => entry.taskId === taskId && entry.graphId === graphId);
  const onListKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const position = stages.findIndex(entry => entry.id === selected);
    const next = stages[Math.max(0, Math.min(stages.length - 1, position + (event.key === "ArrowDown" ? 1 : -1)))];
    if (next) setSelected(next.id);
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const kinds = [...new Set(report.stages.map(entry => entry.kind))];
  return <div className="flex h-full min-h-0 flex-col">
    <PropertySectionTitle aside={<span className="flex items-center gap-3 font-normal text-muted-foreground">{kinds.map(kind => <span key={kind} className="flex items-center gap-1"><span className={cn("size-2", STAGE_KIND_CLASS[kind] ?? "bg-muted-foreground/60")} />{humanizePropertyLabel(kind)}</span>)}</span>}>
      <SelectableText className="font-normal">Frame {report.frame.renderFrameId} · Tick {report.frame.tickId} · {report.frame.backend} · {report.frame.width} × {report.frame.height} · {report.complete ? "Complete" : "Incomplete"} · {report.droppedRecords} dropped records</SelectableText>
    </PropertySectionTitle>
    <div className="grid min-h-80 flex-1 border-y md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-h-0 flex-col">
        <ToolbarStrip className="py-0.5"><SearchInput value={query} onChange={setQuery} placeholder="Search executed stages" aria-label="Search executed stages" /></ToolbarStrip>
        <div className="grid h-6 shrink-0 grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1.4fr)_4rem] items-center gap-2 border-b bg-panel-header px-2 text-[11px] text-muted-foreground">
          <span className="text-right">#</span><span>Stage</span>
          <span className="relative h-full">{ticks.map(tick => <span key={tick} className={cn("absolute top-1/2 -translate-y-1/2 font-mono text-[10px] tabular-nums", tick === 1 ? "-translate-x-full" : tick ? "-translate-x-1/2" : "")} style={{ left: `${tick * 100}%` }}>{(span * tick).toFixed(1)}</span>)}</span>
          <span className="text-right">ms</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto" role="list" aria-label="Executed frame stages" onKeyDown={onListKey}>
          {stages.map((entry, row) => {
            const start = (entry.startedAtMs - origin) / span * 100;
            const width = (entry.submissionMs ?? 0) / span * 100;
            const active = selected === entry.id;
            return <Button key={entry.id} variant="ghost" size="sm" title={`${entry.name} · ${humanizePropertyLabel(entry.kind)} · starts +${format(entry.startedAtMs - origin)} ms · ${format(entry.submissionMs)} ms`}
              className={cn("grid h-7 w-full grid-cols-[1.5rem_minmax(0,1fr)_minmax(0,1.4fr)_4rem] items-center gap-2 rounded-none px-2 text-left text-xs font-normal pointer-coarse:min-h-11", row % 2 === 1 && "bg-list-stripe", active && "bg-accent text-accent-foreground hover:bg-accent")} aria-pressed={active} onClick={() => setSelected(entry.id)}>
              <span className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">{entry.id + 1}</span>
              <span className="truncate" style={{ paddingLeft: `${depth(entry) * 0.75}rem` }}>{entry.name}</span>
              <span className="relative h-3">
                {ticks.slice(1, -1).map(tick => <span key={tick} className="absolute inset-y-[-0.375rem] w-px bg-border/50" style={{ left: `${tick * 100}%` }} />)}
                <span className={cn("absolute inset-y-0 min-w-px", active ? "bg-trace-selected" : STAGE_KIND_CLASS[entry.kind] ?? "bg-muted-foreground/60", !entry.completed && "opacity-50")} style={{ left: `${start}%`, width: `${width}%` }} />
              </span>
              <span className="text-right font-mono text-[11px] tabular-nums">{format(entry.submissionMs)}</span>
            </Button>;
          })}
        </div>
      </div>
      <div className="min-h-0 overflow-auto border-t md:border-t-0 md:border-l">{stage ? <>
        <Facts title={stage.name} aside={humanizePropertyLabel(stage.kind)} data={Object.fromEntries(Object.entries({
          startsAt: `+${format(stage.startedAtMs - origin)} ms`, submission: stage.submissionMs == null ? null : `${format(stage.submissionMs)} ms`,
          drawCalls: stage.drawCalls, completed: stage.completed ? "Yes" : "No", detail: stage.detail, selectedPasses: stage.selectedPasses?.join(", "),
          fallbackPasses: stage.fallbackPasses === undefined ? undefined : stage.fallbackPasses ? "Yes" : "No",
          sceneId: stage.sceneId, actorGuid: stage.actorGuid, materialGuid: stage.materialGuid,
          sceneUniqueId: stage.sceneUniqueId, graphId: stage.graphId, taskId: stage.taskId, parentStage: stage.parentId == null ? undefined : stage.parentId + 1,
        }).filter(([key, value]) => value !== undefined || key === "selectedPasses"))} />
        {task ? <>
          <PropertySectionTitle aside={<span className="font-normal text-muted-foreground">{task.type}</span>}>Task Passes</PropertySectionTitle>
          <ul className="text-xs">{[...task.passes.map(pass => ({ pass, disabled: false })), ...task.disabledPasses.map(pass => ({ pass, disabled: true }))].map(({ pass, disabled }, index) =>
            <li key={`${pass.name}-${index}`} className={cn("flex min-h-7 items-baseline gap-2 px-2 py-1", index % 2 && "bg-list-stripe", disabled && "text-muted-foreground line-through")}>
              <span className="min-w-0 flex-1 truncate">{pass.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{[pass.colorTargets?.length ? `Color ${pass.colorTargets.join(", ")}` : null, pass.depthTarget == null ? null : `Depth ${pass.depthTarget}`].filter(Boolean).join(" · ") || "No Targets"}</span>
            </li>)}
            {!task.passes.length && !task.disabledPasses.length ? <li className="px-2 py-1 text-muted-foreground">No Passes Declared</li> : null}
          </ul>
          <PropertySectionTitle>Depends On</PropertySectionTitle>
          <div className="flex flex-wrap gap-1 px-2 py-1.5">{task.dependencies.length ? task.dependencies.map(id => {
            const target = stageForTask(id, task.graphId);
            const name = report.tasks.find(entry => entry.id === id && entry.graphId === task.graphId)?.name ?? `Task ${id}`;
            return <Button key={id} variant="outline" size="xs" disabled={!target} onClick={() => { if (target) setSelected(target.id); }}>{name}</Button>;
          }) : <span className="text-xs text-muted-foreground">No Dependencies</span>}</div>
          <PropertySectionTitle>Render Targets</PropertySectionTitle>
          <ul className="text-xs">{resources.length ? resources.map((resource, index) => <li key={resource.handle} className={cn("flex min-h-7 items-baseline gap-2 px-2 py-1", index % 2 && "bg-list-stripe")}>
            <span className="w-6 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{resource.handle}</span><SelectableText>{resourceText(resource)}</SelectableText></li>)
            : <li className="px-2 py-1 text-muted-foreground">No Recorded Targets</li>}</ul>
        </> : null}
      </> : <TraceEmptyState title="Select an Executed Stage" description="Task durations include nested passes and driver waits. They are not GPU pass timings." />}</div>
    </div>
    <div className="flex flex-col gap-1 px-2 py-1.5 text-xs text-muted-foreground">
      <p>The list records actual execution order. Graph descriptions and selected passes describe dependencies; they are not independent timing measurements. No output textures were retained.</p>
      {report.limitations.map((limitation, index) => <p key={index}>{limitation}</p>)}
    </div>
    <Facts title="Frame" data={report.frame} columns={3} />
  </div>;
}

export default function DiagnosticResultsDialog({ store }: { store: DiagnosticResultsStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { settings } = useAppSettings();
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);
  const canRecord = state.mode !== null && state.mode !== "simulate" && !state.active && !state.busy;
  const exported = async (copy: boolean) => {
    if (!state.result) return;
    try {
      const text = serializeResult(state.result);
      if (copy) { await navigator.clipboard.writeText(text); setMessage("Copied diagnostic JSON."); }
      else {
        const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = state.result.kind === "profile" ? "performance.babprofile.json" : "frame.babframe.json";
        anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
        setMessage("Exported diagnostic JSON.");
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const status = state.active === "profile" ? "Recording…" : state.active === "frame" ? "Capturing…" : state.mode === "play" ? "Play Session" : state.mode === "preview" ? "Preview Build" : state.mode === "simulate" ? "Simulate" : "No Session";
  return <Dialog open={state.open} onOpenChange={open => { if (!open) store.close(); }}>
    <DialogContent className="flex h-[min(90dvh,900px)] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden rounded-md p-0 sm:max-w-6xl" showCloseButton={false}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-panel-header pr-1 pl-2">
        <DialogTitle className="text-sm font-medium">Profiler and Frame Debugger</DialogTitle>
        <span className={cn("text-xs", state.active ? "text-destructive" : "text-muted-foreground")}>{status}</span>
        <Button size="icon-xs" variant="ghost" className="ml-auto pointer-coarse:size-11" aria-label="Close" onClick={() => store.close()}><XIcon /></Button>
      </div>
      <ToolbarStrip className="gap-1 py-1">
        {state.active === "profile" ? <Button size="sm" variant="outline" disabled={state.busy} onClick={() => void store.stopProfile()}><SquareIcon data-icon="inline-start" className="fill-destructive text-destructive" />Stop Recording</Button>
          : <Button size="sm" variant="outline" disabled={!canRecord} onClick={() => void store.startProfile(profileDefaultsFromSettings(settings.debuggerDefaults))}><CircleIcon data-icon="inline-start" className="fill-destructive text-destructive" />Record Performance</Button>}
        <Button size="sm" variant="outline" disabled={!canRecord} onClick={() => void store.captureFrame()}><CameraIcon data-icon="inline-start" />Capture Frame</Button>
        {state.mode ? <Button size="sm" variant="outline" onClick={() => void store.stopSession()}>Stop Session</Button> : null}
        <Separator orientation="vertical" className="mx-1 h-4 self-center" />
        <ToggleGroup value={[state.view]} onValueChange={value => { if (value[0] === "summary" || value[0] === "timeline" || value[0] === "frame") store.selectView(value[0]); }} variant="outline" size="sm">
          <ToggleGroupItem value="summary">Summary</ToggleGroupItem><ToggleGroupItem value="timeline">Timeline</ToggleGroupItem><ToggleGroupItem value="frame">Frame Report</ToggleGroupItem>
        </ToggleGroup>
        <div className="ml-auto flex items-center">
          <Button size="icon-sm" variant="ghost" aria-label="Open Profile" title="Open Profile" className="pointer-coarse:size-11" disabled={!!state.active || state.busy} onClick={() => input.current?.click()}><FolderOpenIcon /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Copy" title="Copy Diagnostic JSON" className="pointer-coarse:size-11" disabled={!state.result} onClick={() => void exported(true)}><CopyIcon /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Export" title="Export Diagnostic JSON" className="pointer-coarse:size-11" disabled={!state.result} onClick={() => void exported(false)}><DownloadIcon /></Button>
        </div>
      </ToolbarStrip>
      <input ref={input} type="file" accept=".json,application/json" className="hidden" aria-label="Open performance profile" onChange={event => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
        if (!file) return;
        if (file.size > 128 * 1024 * 1024) { setMessage("Profile import exceeds the 128 MiB file limit."); return; }
        void file.text().then(text => {
          const profile = parsePerformanceProfile(JSON.parse(text));
          if (!profile) throw new Error("This is not a valid supported Performance profile.");
          store.importResult({ kind: "profile", profile }); setMessage(null);
        }).catch(error => setMessage(error instanceof Error ? error.message : String(error)));
      }} />
      <div className="min-h-0 flex-1"><PanelFrame data-testid="session-diagnostic-results">
        {state.result?.kind === "profile" && state.view !== "frame" ? state.view === "summary" ? <PerformanceSummary profile={state.result.profile} /> : <PerformanceTimeline profile={state.result.profile} />
          : state.result?.kind === "frame" && state.view === "frame" ? <FrameReportView report={state.result.report} />
            : <Empty>
              <EmptyHeader>
                <EmptyTitle>{state.result ? state.result.kind === "frame" ? "No Performance Recording" : "No Frame Capture" : "No Capture Selected"}</EmptyTitle>
                <EmptyDescription>{state.view === "frame" ? "Capture one frame to list every render stage in execution order." : "Record Performance to collect frame and tick timings."} Opening this surface does not collect data.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="flex-row justify-center">
                {state.view === "frame"
                  ? <Button size="sm" variant="outline" disabled={!canRecord} onClick={() => void store.captureFrame()}><CameraIcon data-icon="inline-start" />Capture Frame</Button>
                  : <Button size="sm" variant="outline" disabled={!canRecord} onClick={() => void store.startProfile(profileDefaultsFromSettings(settings.debuggerDefaults))}><CircleIcon data-icon="inline-start" className="fill-destructive text-destructive" />Record Performance</Button>}
                <Button size="sm" variant="ghost" disabled={!!state.active || state.busy} onClick={() => input.current?.click()}><FolderOpenIcon data-icon="inline-start" />Open Profile</Button>
              </EmptyContent>
            </Empty>}
      </PanelFrame></div>
      <div className="flex min-h-6 shrink-0 flex-wrap items-center gap-x-3 border-t bg-panel-header px-2 py-0.5 text-[11px] text-muted-foreground">
        {state.mode === "simulate" || state.mode === null ? <p>Use Play or Preview Build for recording and frame capture. Saved results remain available.</p> : null}
        {state.active ? <p role="status" className="text-foreground">{state.active === "profile" ? "Recording compact timing samples. The configured duration and budget stop collection automatically." : "Waiting for the next coherent game presentation…"}</p> : null}
        {state.error ? <p role="alert" className="text-destructive">{state.error}</p> : null}{message ? <p role="status">{message}</p> : null}
      </div>
    </DialogContent>
  </Dialog>;
}
