import { useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import {
  parsePerformanceProfile,
  serializePerformanceProfile,
  summarizePerformanceColumn,
  summarizePerformanceColumns,
  TICK_BUDGET_MS,
  TICK_TIMING_PHASE_LABELS,
  TICK_TIMING_PHASES,
  type PerformanceProfile,
} from "@haptic/debugger";
import { parseRenderFrameReport, serializeRenderFrameReport, type RenderFrameReport } from "@haptic/render";
import {
  humanizePropertyLabel,
  PanelFrame,
  PropertySectionTitle,
  SearchInput,
  SelectableText,
  ToolbarStrip,
} from "@haptic/editor-kit";
import { Button } from "@haptic/ui/components/button";
import { Dialog, DialogContent, DialogTitle } from "@haptic/ui/components/dialog";
import { Separator } from "@haptic/ui/components/separator";
import { cn } from "@haptic/ui/lib/utils";
import { CameraIcon, CircleIcon, CopyIcon, DownloadIcon, FolderOpenIcon, SquareIcon, XIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@haptic/ui/components/toggle-group";
import { useAppSettings } from "../context/app-settings-context";
import { downloadBlob } from "../lib/download";
import { profileDefaultsFromSettings } from "../lib/play-debugger-defaults";
import { DiagnosticResultsStore, type DiagnosticResult } from "../services/diagnostic-results-store";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@haptic/ui/components/empty";
import { TraceEmptyState } from "./trace-inspection-controls";
import { Facts } from "./diagnostic-facts";
import { PerformanceTimeline } from "./performance-timeline";
import { formatRecorded as format, frameBudget } from "../lib/performance-timeline-model";

const TABLE = "w-full border-collapse text-left text-xs";
const TH = "sticky top-0 z-10 h-7 border-b bg-panel-header px-2 font-medium whitespace-nowrap text-muted-foreground";
const TR = "h-7 even:bg-list-stripe hover:bg-accent/50";
const TD = "px-2 text-right font-mono text-[11px] tabular-nums";
const percent = (part: number, whole: number) => whole ? `${(part / whole * 100).toFixed(1)}%` : "0.0%";

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
  return result.kind === "profile" ? serializePerformanceProfile(result.profile) : serializeRenderFrameReport(result.report);
}

/** A saved recording or frame report, or null when the file is neither in a version this build reads. */
function parseResult(value: unknown): DiagnosticResult | null {
  const profile = parsePerformanceProfile(value);
  if (profile) return { kind: "profile", profile };
  const report = parseRenderFrameReport(value);
  return report ? { kind: "frame", report } : null;
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
      ["Worker Script and Physics", summarizePerformanceColumns(profile.ticks, ["scriptMs", "physicsMs"], TICK_BUDGET_MS), TICK_BUDGET_MS],
      ["Worker Script Phase", summarizePerformanceColumn(profile.ticks, "scriptMs")],
      // Version 2 profiles split script into the tick's phases; a version 1 profile has none to show.
      ...TICK_TIMING_PHASES.filter((phase) => phase !== "physics")
        .map((phase): SummaryRow => [`${TICK_TIMING_PHASE_LABELS[phase]} Phase`, summarizePerformanceColumn(profile.ticks, `${phase}Ms`)])
        .filter(([, values]) => values.count > 0),
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
        { label: "Frame Pacing", over: frame.overBudgetCount ?? 0, text: frame.median == null ? "No completed frame intervals." : <>
          Median <b className="font-mono text-[11px] font-medium">{format(frame.median)} ms</b> ({(1000 / frame.median).toFixed(1)} FPS) ·{" "}
          <span className={cn((frame.overBudgetCount ?? 0) && "text-destructive")}>
            {frame.overBudgetCount ?? 0} of {frame.count} frames ({percent(frame.overBudgetCount ?? 0, frame.count)})
          </span>{" "}
          slower than {budget.toFixed(2)} ms
        </> },
        { label: "Worker Tick", over: worker.overBudgetCount ?? 0, text: worker.median == null ? "No runtime ticks." : <>
          Median <b className="font-mono text-[11px] font-medium">{format(worker.median)} ms</b> script and physics ·{" "}
          <span className={cn((worker.overBudgetCount ?? 0) && "text-destructive")}>
            {worker.overBudgetCount ?? 0} of {worker.count} ticks ({percent(worker.overBudgetCount ?? 0, worker.count)})
          </span>{" "}
          slower than {TICK_BUDGET_MS} ms
        </> },
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
      <p>Frame threshold {budget.toFixed(2)} ms. Combined Worker script and physics threshold {TICK_BUDGET_MS} ms per tick. Submission includes driver waits; asynchronous copy latency can overlap submission. Concurrent host and Worker durations are not summed.</p>
      <p>GPU timing: {gpu ? `${profile.gpu.count} engine-aggregate query results, not aligned to frames` : profile.identity.gpuReason ?? profile.identity.gpuTiming}. Heap and physical VRAM: unavailable. These captures contain timing records and no world snapshots.</p>
      <p>Retained {(profile.retainedBytes / 1048576).toFixed(2)} MiB / {(profile.byteBudget / 1048576).toFixed(0)} MiB budget; {profile.droppedRecords} dropped records. Accounted buffers are not a browser heap limit.</p>
    </div>
    <Facts title="Session" data={profile.identity} columns={3} />
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
  // Summary and Timeline show the recording; Frame Report shows the capture. Copy and Export follow the view.
  const shown: DiagnosticResult | null = state.view === "frame"
    ? state.frame ? { kind: "frame", report: state.frame } : null
    : state.profile ? { kind: "profile", profile: state.profile } : null;
  const exported = async (copy: boolean) => {
    if (!shown) return;
    try {
      const text = serializeResult(shown);
      if (copy) { await navigator.clipboard.writeText(text); setMessage("Copied diagnostic JSON."); }
      else {
        downloadBlob(new Blob([text], { type: "application/json" }), shown.kind === "profile" ? "performance.babprofile.json" : "frame.babframe.json");
        setMessage("Exported diagnostic JSON.");
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  const status = state.active === "profile" ? "Recording…" : state.active === "frame" ? "Capturing…" : state.mode === "play" ? "Play Session" : state.mode === "preview" ? "Preview Build" : state.mode === "simulate" ? "Simulate" : "No Session";
  return <Dialog open={state.open} onOpenChange={open => { if (!open) store.close(); }}>
    <DialogContent className="h-[min(90dvh,900px)] max-w-[calc(100%-1rem)] rounded-md sm:max-w-6xl" bodyClassName="flex flex-col gap-0 overflow-hidden p-0" showCloseButton={false}>
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
          <Button size="icon-sm" variant="ghost" aria-label="Open Saved Result" title="Open Saved Result" className="pointer-coarse:size-11"
            disabled={!!state.active || state.busy} onClick={() => input.current?.click()}><FolderOpenIcon /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Copy" title="Copy Diagnostic JSON" className="pointer-coarse:size-11"
            disabled={!shown} onClick={() => void exported(true)}><CopyIcon /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Export" title="Export Diagnostic JSON" className="pointer-coarse:size-11"
            disabled={!shown} onClick={() => void exported(false)}><DownloadIcon /></Button>
        </div>
      </ToolbarStrip>
      <input ref={input} type="file" accept=".json,application/json" className="hidden" aria-label="Open saved result" onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        if (file.size > 128 * 1024 * 1024) { setMessage("This file exceeds the 128 MiB limit for saved results."); return; }
        void file.text().then(text => {
          const result = parseResult(JSON.parse(text));
          if (!result) throw new Error("This file is not a Performance recording or frame report this version can open.");
          store.importResult(result);
          setMessage(null);
        }).catch(error => setMessage(error instanceof Error ? error.message : String(error)));
      }} />
      <div className="min-h-0 flex-1"><PanelFrame data-testid="session-diagnostic-results">
        {shown?.kind === "profile" ? state.view === "summary" ? <PerformanceSummary profile={shown.profile} /> : <PerformanceTimeline profile={shown.profile} />
          : shown?.kind === "frame" ? <FrameReportView report={shown.report} />
            : <Empty>
              <EmptyHeader>
                <EmptyTitle>{state.view === "frame" ? "No Frame Capture" : "No Performance Recording"}</EmptyTitle>
                <EmptyDescription>{state.view === "frame" ? "Capture one frame to list every render stage in execution order." : "Record Performance to collect frame and tick timings."} Opening this surface does not collect data.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="flex-row justify-center">
                {state.view === "frame"
                  ? <Button size="sm" variant="outline" disabled={!canRecord} onClick={() => void store.captureFrame()}><CameraIcon data-icon="inline-start" />Capture Frame</Button>
                  : <Button size="sm" variant="outline" disabled={!canRecord} onClick={() => void store.startProfile(profileDefaultsFromSettings(settings.debuggerDefaults))}><CircleIcon data-icon="inline-start" className="fill-destructive text-destructive" />Record Performance</Button>}
                <Button size="sm" variant="ghost" disabled={!!state.active || state.busy} onClick={() => input.current?.click()}><FolderOpenIcon data-icon="inline-start" />Open Saved Result</Button>
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
