import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { parsePerformanceProfile, serializePerformanceProfile, summarizePerformanceColumn, summarizePerformanceColumns, type PerformanceProfile, type PerformanceStream } from "@babylonslate/debugger";
import type { RenderFrameReport } from "@babylonslate/render";
import { humanizePropertyLabel, NumberField, PanelFrame, PropertySectionTitle, SearchInput, SelectableText, ToolbarStrip } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@babylonslate/ui/components/dialog";
import { Separator } from "@babylonslate/ui/components/separator";
import { cn } from "@babylonslate/ui/lib/utils";
import { CameraIcon, ChevronLeftIcon, ChevronRightIcon, CircleIcon, CopyIcon, DownloadIcon, FolderOpenIcon, SquareIcon, XIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@babylonslate/ui/components/toggle-group";
import { useAppSettings } from "../context/app-settings-context";
import { profileDefaultsFromSettings } from "../lib/play-debugger-defaults";
import { DiagnosticResultsStore, type DiagnosticResult } from "../services/diagnostic-results-store";
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
const STREAM_METRIC = {
  frames: { columns: ["intervalMs"], label: "Frame Interval" },
  ticks: { columns: ["scriptMs", "physicsMs"], label: "Script + Physics" },
  gpu: { columns: ["durationMs"], label: "GPU Duration" },
} as const;
const TABLE = "w-full border-collapse text-left text-xs";
const TH = "sticky top-0 z-10 h-7 border-b bg-panel-header px-2 font-medium whitespace-nowrap text-muted-foreground";
const TR = "h-7 even:bg-list-stripe hover:bg-accent/50";
const TD = "px-2 text-right font-mono text-[11px] tabular-nums";

/** Bucketed bar chart over one stream; each bar selects its slowest sample. */
function SampleChart({ series, selected, threshold, onSelect }: { series: Float64Array; selected: number; threshold?: number; onSelect: (index: number) => void }) {
  const buckets = useMemo(() => {
    const count = Math.min(240, series.length);
    return Array.from({ length: count }, (_, bucket) => {
      const start = Math.floor(bucket * series.length / count);
      const end = Math.max(start, Math.floor((bucket + 1) * series.length / count) - 1);
      let peak = start;
      for (let index = start; index <= end; index++) if (!(series[index]! <= series[peak]!)) peak = index;
      return { start, end, peak, value: Number.isFinite(series[peak]) ? series[peak]! : 0 };
    });
  }, [series]);
  const scale = Math.max(threshold ?? 0, ...buckets.map(bucket => bucket.value)) * 1.1 || 1;
  return <div className="flex flex-col">
    <div className="h-24 border-b bg-background px-2 pt-2" data-testid="diagnostic-sample-chart">
      <div className="relative flex h-full items-end gap-px">
        {buckets.map(bucket => {
          const active = selected >= bucket.start && selected <= bucket.end;
          const over = threshold !== undefined && bucket.value > threshold;
          const title = `Samples ${bucket.start}–${bucket.end} · Peak ${format(bucket.value)} ms`;
          return <Button key={bucket.start} variant="ghost" aria-label={title} title={title} aria-current={active ? "true" : undefined} onClick={() => onSelect(bucket.peak)}
            className="h-full min-w-0 flex-1 items-end rounded-none border-0 p-0">
            <span className={cn("block w-full", active ? "bg-trace-selected" : over ? "bg-destructive/80" : "bg-trace-script")}
              style={{ height: `${Math.max(1, bucket.value / scale * 100)}%` }} />
          </Button>;
        })}
        {threshold !== undefined ? <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-destructive/70" style={{ bottom: `${threshold / scale * 100}%` }}>
          <span className="absolute right-0 bottom-0.5 rounded-sm bg-background/80 px-1 text-[0.65rem] text-destructive tabular-nums">{threshold.toFixed(2)} ms</span>
        </div> : null}
      </div>
    </div>
  </div>;
}

function serializeResult(result: DiagnosticResult) {
  return result.kind === "profile" ? serializePerformanceProfile(result.profile) : JSON.stringify({ kind: "babylonslate-frame", version: 1, report: result.report });
}

/** Leaf content also fits an ordinary DockView PanelFrame; no document asset or independent log. */
export function PerformanceSummary({ profile }: { profile: PerformanceProfile }) {
  const budget = profile.identity.frameCap && profile.identity.frameCap > 0 ? 1000 / profile.identity.frameCap : 1000 / 60;
  const gpu = profile.identity.gpuTiming === "unpaired";
  const rows = useMemo(() => [
    ["Completed Game-Frame Interval", summarizePerformanceColumn(profile.frames, "intervalMs", budget)],
    ["Main Preparation Wall Time", summarizePerformanceColumn(profile.frames, "preparationMs")],
    ["Main Submission Wall Time", summarizePerformanceColumn(profile.frames, "submissionMs")],
    ["Presentation/Copy Wall Time", summarizePerformanceColumn(profile.frames, "copyMs")],
    ["Worker Script and Physics", summarizePerformanceColumns(profile.ticks, ["scriptMs", "physicsMs"], 8)],
    ["Worker Script Phase", summarizePerformanceColumn(profile.ticks, "scriptMs")],
    ["Worker Physics Phase", summarizePerformanceColumn(profile.ticks, "physicsMs")],
    ["Worker Snapshot Publish", summarizePerformanceColumn(profile.ticks, "publishMs")],
    ["Other Measured Runtime Phase", summarizePerformanceColumn(profile.ticks, "otherMs")],
    ...(gpu ? [["GPU Time (Engine Aggregate)", summarizePerformanceColumn(profile.gpu, "durationMs")] as const] : []),
  ] as const, [profile, budget, gpu]);
  const median = rows[0][1].median;
  return <div className="flex flex-col">
    <PropertySectionTitle aside={<span className="font-normal text-muted-foreground tabular-nums">{median ? `${(1000 / median).toFixed(1)} FPS Median` : null}</span>}>
      <SelectableText className="font-normal">{profile.frames.count} completed frame samples · {profile.ticks.count} runtime tick samples · {(profile.durationMs / 1000).toFixed(2)} s · stopped: {profile.stopReason}</SelectableText>
    </PropertySectionTitle>
    <div className="overflow-x-auto"><table className={TABLE}>
      <caption className="caption-bottom px-2 py-1.5 text-left text-xs text-muted-foreground">Durations in milliseconds. Frame and tick populations are independent.</caption>
      <thead><tr>{["Population", "Count", "Median", "p95", "p99", "Maximum", "Over Budget"].map((label, index) => <th key={label} className={cn(TH, index && "text-right")}>{label}</th>)}</tr></thead>
      <tbody>{rows.map(([label, values]) => <tr key={label} className={TR}><th className="px-2 font-normal whitespace-nowrap">{label}</th>
        <td className={cn(TD, "text-muted-foreground")}>{values.count}</td>{[values.median, values.p95, values.p99, values.maximum].map((value, index) => <td key={index} className={TD}>{format(value)}</td>)}
        <td className={cn(TD, values.overBudgetCount ? "text-destructive" : "text-muted-foreground", values.overBudgetCount == null && "font-sans text-xs")}>{values.overBudgetCount ?? "No threshold"}</td></tr>)}</tbody>
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
  const index = Math.max(0, Math.min(Number.isFinite(selected) ? Math.floor(selected) : 0, Math.max(0, stream.count - 1)));
  const page = Math.floor(index / 100) * 100;
  const indices = Array.from({ length: Math.min(100, Math.max(0, stream.count - page)) }, (_, offset) => page + offset);
  const values = rowAt(stream, index);
  const series = useMemo(() => columnSeries(stream, STREAM_METRIC[population].columns), [stream, population]);
  const threshold = population === "frames" ? (profile.identity.frameCap && profile.identity.frameCap > 0 ? 1000 / profile.identity.frameCap : 1000 / 60) : population === "ticks" ? 8 : undefined;
  return <div className="flex h-full min-h-0 flex-col">
    <ToolbarStrip className="gap-2 py-0.5">
      <ToggleGroup value={[population]} onValueChange={next => { if (next[0] === "frames" || next[0] === "ticks" || next[0] === "gpu") { setPopulation(next[0]); setSelected(0); } }} size="sm" variant="outline">
        <ToggleGroupItem value="frames">Completed Frames</ToggleGroupItem><ToggleGroupItem value="ticks">Runtime Ticks</ToggleGroupItem>
        {profile.gpu.count ? <ToggleGroupItem value="gpu">GPU Queries</ToggleGroupItem> : null}
      </ToggleGroup>
      {stream.count ? <div className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
        <label htmlFor="diagnostic-sample-index">Sample</label>
        <div className="w-20"><NumberField id="diagnostic-sample-index" min={0} max={stream.count - 1} step={1} value={index} onChange={setSelected} /></div>
        <span className="tabular-nums">/ {stream.count - 1}</span>
        <Button variant="ghost" size="icon-sm" aria-label="Previous 100" title="Previous 100" className="pointer-coarse:size-11" disabled={!index} onClick={() => setSelected(Math.max(0, page - 100))}><ChevronLeftIcon /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="Next 100" title="Next 100" className="pointer-coarse:size-11" disabled={page + 100 >= stream.count} onClick={() => setSelected(page + 100)}><ChevronRightIcon /></Button>
      </div> : null}
    </ToolbarStrip>
    {stream.count ? <>
      <SampleChart series={series} selected={index} threshold={threshold} onSelect={setSelected} />
      <p className="border-b px-2 py-1 text-xs text-muted-foreground">{STREAM_METRIC[population].label} per sample, peak {format(Math.max(0, ...series.filter(Number.isFinite)))} ms. Each stream uses its own recording-relative clock. Rows are not aligned by host/Worker timestamps. Loading samples are explicitly marked.</p>
      <div className="flex min-h-64 flex-1">
        <div className="min-w-0 flex-1 overflow-auto"><table className={TABLE}><thead><tr><th className={TH}>Sample</th>{stream.columns.map(column => <th className={cn(TH, "text-right")} key={column}>{humanizePropertyLabel(column)}</th>)}</tr></thead>
          <tbody>{indices.map(row => <tr key={row} aria-selected={row === index} className={cn(TR, row === index && "bg-accent even:bg-accent hover:bg-accent")}>
            <td className="p-0"><Button variant="ghost" size="xs" className="h-7 w-full justify-start rounded-none font-mono text-[11px] tabular-nums pointer-coarse:min-h-11" onClick={() => setSelected(row)}>{row}</Button></td>
            {rowAt(stream, row).map((value, column) => <td className={TD} key={column}>{Number.isFinite(value) ? Number.isInteger(value) ? value : value.toFixed(3) : <span className="font-sans text-xs text-muted-foreground">Unavailable</span>}</td>)}</tr>)}</tbody></table></div>
        <div className="hidden w-72 shrink-0 overflow-auto border-l lg:block">
          <Facts title={`Sample ${index}`} data={Object.fromEntries(stream.columns.map((column, offset) => [column, Number.isFinite(values[offset]) ? values[offset] : null]))} />
        </div>
      </div>
    </> : <TraceEmptyState title="No Samples" description="This population had no completed samples during the recording." />}
  </div>;
}

export function FrameReportView({ report }: { report: RenderFrameReport }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const stages = report.stages.filter(stage => `${stage.name} ${stage.kind}`.toLowerCase().includes(query.toLowerCase()));
  const stage = report.stages.find(entry => entry.id === selected);
  const task = stage?.taskId == null ? undefined : report.tasks.find(entry => entry.id === stage.taskId && entry.graphId === stage.graphId);
  const handles = new Set(task?.passes.flatMap(pass => [...(pass.colorTargets ?? []), ...(pass.depthTarget == null ? [] : [pass.depthTarget])]) ?? []);
  const slowest = Math.max(0, ...report.stages.map(entry => entry.submissionMs ?? 0)) || 1;
  return <div className="flex h-full min-h-0 flex-col">
    <PropertySectionTitle aside={<span className="font-normal text-muted-foreground tabular-nums">{report.stages.length} stages</span>}>
      <SelectableText className="font-normal">Frame {report.frame.renderFrameId} · Tick {report.frame.tickId} · {report.frame.backend} · {report.frame.width} × {report.frame.height} · {report.complete ? "Complete" : "Incomplete"} · {report.droppedRecords} dropped records</SelectableText>
    </PropertySectionTitle>
    <div className="grid min-h-80 flex-1 border-y md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-h-0 flex-col">
        <ToolbarStrip className="py-0.5"><SearchInput value={query} onChange={setQuery} placeholder="Search executed stages" aria-label="Search executed stages" /></ToolbarStrip>
        <div className="min-h-0 flex-1 overflow-auto" role="list" aria-label="Executed frame stages">
          {stages.map((entry, row) => <Button key={entry.id} variant="ghost" size="sm" className={cn("grid h-7 w-full grid-cols-[1.5rem_minmax(0,1fr)_6rem_4rem_4.5rem] items-center gap-2 rounded-none px-2 text-left text-xs font-normal pointer-coarse:min-h-11", row % 2 === 1 && "bg-list-stripe", selected === entry.id && "bg-accent text-accent-foreground hover:bg-accent")} aria-pressed={selected === entry.id} onClick={() => setSelected(entry.id)}>
            <span className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">{entry.id + 1}</span>
            <span className="truncate">{entry.name}</span>
            <span className="truncate text-muted-foreground">{humanizePropertyLabel(entry.kind)}</span>
            <span className="h-1 bg-muted"><span className="block h-full bg-trace-script" style={{ width: `${(entry.submissionMs ?? 0) / slowest * 100}%` }} /></span>
            <span className="text-right font-mono text-[11px] tabular-nums">{format(entry.submissionMs)}</span></Button>)}
        </div>
      </div>
      <div className="min-h-0 overflow-auto border-t md:border-t-0 md:border-l">{stage ? <>
        <Facts title={stage.name} data={{ ...stage, selectedPasses: stage.selectedPasses, taskType: task?.type, declaredPasses: task?.passes,
          disabledPasses: task?.disabledPasses, dependencies: task?.dependencies,
          resources: report.resources.filter(resource => resource.graphId === stage.graphId && handles.has(resource.handle)) }} />
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
            : <TraceEmptyState title="No Capture Selected" description="Explicitly record Performance or capture one frame. Opening this surface does not collect data." />}
      </PanelFrame></div>
      <div className="flex min-h-6 shrink-0 flex-wrap items-center gap-x-3 border-t bg-panel-header px-2 py-0.5 text-[11px] text-muted-foreground">
        {state.mode === "simulate" || state.mode === null ? <p>Use Play or Preview Build for recording and frame capture. Saved results remain available.</p> : null}
        {state.active ? <p role="status" className="text-foreground">{state.active === "profile" ? "Recording compact timing samples. The configured duration and budget stop collection automatically." : "Waiting for the next coherent game presentation…"}</p> : null}
        {state.error ? <p role="alert" className="text-destructive">{state.error}</p> : null}{message ? <p role="status">{message}</p> : null}
      </div>
    </DialogContent>
  </Dialog>;
}
