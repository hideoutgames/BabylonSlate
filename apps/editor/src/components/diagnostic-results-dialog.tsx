import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { parsePerformanceProfile, serializePerformanceProfile, summarizePerformanceColumn, summarizePerformanceColumns, type PerformanceProfile, type PerformanceStream } from "@babylonslate/debugger";
import type { RenderFrameReport } from "@babylonslate/render";
import { NumberField, PanelFrame, PropertyGrid, SearchInput, SelectableText, type PropertyRow } from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@babylonslate/ui/components/dialog";
import { ToggleGroup, ToggleGroupItem } from "@babylonslate/ui/components/toggle-group";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";
import { useAppSettings } from "../context/app-settings-context";
import { profileDefaultsFromSettings } from "../lib/play-debugger-defaults";
import { DiagnosticResultsStore, type DiagnosticResult } from "../services/diagnostic-results-store";
import { TraceEmptyState } from "./trace-inspection-controls";

const format = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "Unavailable" : value.toFixed(3);
const textRows = (data: Record<string, unknown>): PropertyRow[] => Object.entries(data).map(([id, value]) => ({
  kind: "text", id, label: id, value: value == null ? "Unavailable" : typeof value === "string" ? value : JSON.stringify(value), selectableText: true,
}));
function rowAt(stream: PerformanceStream, index: number): number[] {
  let offset = index * stream.columns.length;
  for (const chunk of stream.chunks) {
    if (offset < chunk.length) return Array.from(chunk.subarray(offset, offset + stream.columns.length));
    offset -= chunk.length;
  }
  return [];
}
function serializeResult(result: DiagnosticResult) {
  return result.kind === "profile" ? serializePerformanceProfile(result.profile) : JSON.stringify({ kind: "babylonslate-frame", version: 1, report: result.report });
}

/** Leaf content also fits an ordinary DockView PanelFrame; no document asset or independent log. */
export function PerformanceSummary({ profile }: { profile: PerformanceProfile }) {
  const budget = profile.identity.frameCap && profile.identity.frameCap > 0 ? 1000 / profile.identity.frameCap : 1000 / 60;
  const rows = useMemo(() => [
    ["Completed game-frame interval", summarizePerformanceColumn(profile.frames, "intervalMs", budget)],
    ["Main preparation wall time", summarizePerformanceColumn(profile.frames, "preparationMs")],
    ["Main submission wall time", summarizePerformanceColumn(profile.frames, "submissionMs")],
    ["Presentation/copy wall time", summarizePerformanceColumn(profile.frames, "copyMs")],
    ["Worker script and physics", summarizePerformanceColumns(profile.ticks, ["scriptMs", "physicsMs"], 8)],
    ["Worker script phase", summarizePerformanceColumn(profile.ticks, "scriptMs")],
    ["Worker physics phase", summarizePerformanceColumn(profile.ticks, "physicsMs")],
    ["Worker snapshot publish", summarizePerformanceColumn(profile.ticks, "publishMs")],
    ["Other measured runtime phase", summarizePerformanceColumn(profile.ticks, "otherMs")],
  ] as const, [profile, budget]);
  return <div className="flex flex-col gap-3 p-2">
    <p><SelectableText>{profile.frames.count} completed frame samples · {profile.ticks.count} runtime tick samples · {(profile.durationMs / 1000).toFixed(2)} s · stopped: {profile.stopReason}</SelectableText></p>
    <div className="overflow-x-auto"><table className="w-full text-left text-xs">
      <caption className="text-left">Durations in milliseconds. Frame and tick populations are independent.</caption>
      <thead><tr>{["Population", "Count", "Median", "p95", "p99", "Maximum", "Over Budget"].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead>
      <tbody>{rows.map(([label, values]) => <tr key={label}><th className="p-2 font-medium">{label}</th>
        <td className="p-2">{values.count}</td>{[values.median, values.p95, values.p99, values.maximum].map((value, index) => <td key={index} className="p-2 tabular-nums">{format(value)}</td>)}
        <td className="p-2">{values.overBudgetCount ?? "No threshold"}</td></tr>)}</tbody>
    </table></div>
    <p className="text-xs text-muted-foreground">Frame threshold {budget.toFixed(2)} ms. Combined Worker script and physics threshold 8 ms per tick. Submission includes driver waits; asynchronous copy latency can overlap submission. Concurrent host and Worker durations are not summed.</p>
    <p className="text-xs text-muted-foreground">GPU timing: {profile.identity.gpuTiming}. Heap and physical VRAM: unavailable. These captures contain timing records and no world snapshots.</p>
    <p className="text-xs text-muted-foreground">Retained {(profile.retainedBytes / 1048576).toFixed(2)} MiB / {(profile.byteBudget / 1048576).toFixed(0)} MiB budget; {profile.droppedRecords} dropped records. Accounted buffers are not a browser heap limit.</p>
    <PropertyGrid rows={textRows(profile.identity)} readOnly />
  </div>;
}

export function PerformanceTimeline({ profile }: { profile: PerformanceProfile }) {
  const [population, setPopulation] = useState("frames");
  const [selected, setSelected] = useState(0);
  const stream = population === "frames" ? profile.frames : profile.ticks;
  const index = Math.max(0, Math.min(Number.isFinite(selected) ? Math.floor(selected) : 0, Math.max(0, stream.count - 1)));
  const page = Math.floor(index / 100) * 100;
  const indices = Array.from({ length: Math.min(100, Math.max(0, stream.count - page)) }, (_, offset) => page + offset);
  const values = rowAt(stream, index);
  return <div className="flex flex-col gap-3 p-2">
    <ToggleGroup value={[population]} onValueChange={next => { if (next[0]) { setPopulation(String(next[0])); setSelected(0); } }} size="sm" variant="outline">
      <ToggleGroupItem value="frames">Completed Frames</ToggleGroupItem><ToggleGroupItem value="ticks">Runtime Ticks</ToggleGroupItem>
    </ToggleGroup>
    <p className="text-xs text-muted-foreground">Each stream uses its own recording-relative clock. Rows are not aligned by host/Worker timestamps. Loading samples are explicitly marked.</p>
    {stream.count ? <>
      <Field><FieldLabel htmlFor="diagnostic-sample-index">Selected Sample (0–{stream.count - 1})</FieldLabel>
        <NumberField id="diagnostic-sample-index" min={0} max={stream.count - 1} step={1} value={index} onChange={setSelected} />
      </Field>
      <div className="flex gap-2"><Button variant="outline" size="sm" disabled={!index} onClick={() => setSelected(Math.max(0, page - 100))}>Previous 100</Button>
        <Button variant="outline" size="sm" disabled={page + 100 >= stream.count} onClick={() => setSelected(page + 100)}>Next 100</Button></div>
      <div className="max-h-64 overflow-auto"><table className="w-full text-left text-xs"><thead><tr><th>Sample</th>{stream.columns.map(column => <th className="p-2" key={column}>{column}</th>)}</tr></thead>
        <tbody>{indices.map(row => <tr key={row} aria-selected={row === index}><td><Button variant="ghost" size="sm" onClick={() => setSelected(row)}>{row}</Button></td>
          {rowAt(stream, row).map((value, column) => <td className="p-2 tabular-nums" key={column}>{Number.isFinite(value) ? Number.isInteger(value) ? value : value.toFixed(3) : "Unavailable"}</td>)}</tr>)}</tbody></table></div>
      <PropertyGrid rows={textRows(Object.fromEntries(stream.columns.map((column, offset) => [column, Number.isFinite(values[offset]) ? values[offset] : null])))} readOnly />
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
  return <div className="flex flex-col gap-3 p-2">
    <p><SelectableText>Frame {report.frame.renderFrameId} · Tick {report.frame.tickId} · {report.frame.backend} · {report.frame.width} × {report.frame.height} · {report.complete ? "Complete" : "Incomplete"} · {report.droppedRecords} dropped records</SelectableText></p>
    <SearchInput value={query} onChange={event => setQuery(event.target.value)} placeholder="Search executed stages" aria-label="Search executed stages" />
    <div className="grid min-h-0 gap-3 sm:grid-cols-2"><div className="max-h-80 overflow-auto" role="list" aria-label="Executed frame stages">
      {stages.map(entry => <Button key={entry.id} variant="ghost" size="sm" className="w-full justify-start pointer-coarse:min-h-11" aria-pressed={selected === entry.id} onClick={() => setSelected(entry.id)}>
        {entry.id + 1}. {entry.name} · {entry.kind} · {format(entry.submissionMs)} ms</Button>)}
    </div><div>{stage ? <>
      <PropertyGrid rows={textRows({ ...stage, selectedPasses: stage.selectedPasses, taskType: task?.type, declaredPasses: task?.passes,
        disabledPasses: task?.disabledPasses, dependencies: task?.dependencies,
        resources: report.resources.filter(resource => resource.graphId === stage.graphId && handles.has(resource.handle)) })} readOnly />
    </> : <TraceEmptyState title="Select an Executed Stage" description="Task durations include nested passes and driver waits. They are not GPU pass timings." />}</div></div>
    <p className="text-xs text-muted-foreground">The list records actual execution order. Graph descriptions and selected passes describe dependencies; they are not independent timing measurements. No output textures were retained.</p>
    {report.limitations.map((limitation, index) => <p className="text-xs text-muted-foreground" key={index}>{limitation}</p>)}
    <PropertyGrid rows={textRows(report.frame)} readOnly />
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
  return <Dialog open={state.open} onOpenChange={open => { if (!open) store.close(); }}>
    <DialogContent className="flex h-[min(90dvh,900px)] max-w-[calc(100%-1rem)] flex-col gap-3 sm:max-w-6xl" showCloseButton={false}>
      <DialogHeader><DialogTitle>Profiler and Frame Debugger</DialogTitle></DialogHeader>
      <div className="flex shrink-0 flex-wrap gap-2">
        {state.active === "profile" ? <Button size="sm" disabled={state.busy} onClick={() => void store.stopProfile()}>Stop Recording</Button>
          : <Button size="sm" disabled={!canRecord} onClick={() => void store.startProfile(profileDefaultsFromSettings(settings.debuggerDefaults))}>Record Performance</Button>}
        <Button size="sm" variant="outline" disabled={!canRecord} onClick={() => void store.captureFrame()}>Capture Frame</Button>
        <Button size="sm" variant="outline" disabled={!state.result} onClick={() => void exported(true)}>Copy</Button>
        <Button size="sm" variant="outline" disabled={!state.result} onClick={() => void exported(false)}>Export</Button>
        <Button size="sm" variant="outline" disabled={!!state.active || state.busy} onClick={() => input.current?.click()}>Open Profile</Button>
        {state.mode ? <Button size="sm" variant="secondary" onClick={() => void store.stopSession()}>Stop Session</Button> : null}
        <Button size="sm" variant="outline" onClick={() => store.close()}>Close</Button>
      </div>
      {state.mode === "simulate" || state.mode === null ? <p className="text-xs text-muted-foreground">Use Play or Preview Build for recording and frame capture. Saved results remain available.</p> : null}
      {state.active ? <p role="status">{state.active === "profile" ? "Recording compact timing samples. The configured duration and budget stop collection automatically." : "Waiting for the next coherent game presentation…"}</p> : null}
      {state.error ? <p role="alert">{state.error}</p> : null}{message ? <p role="status">{message}</p> : null}
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
      <ToggleGroup value={[state.view]} onValueChange={value => { if (value[0] === "summary" || value[0] === "timeline" || value[0] === "frame") store.selectView(value[0]); }} variant="outline" size="sm">
        <ToggleGroupItem value="summary">Summary</ToggleGroupItem><ToggleGroupItem value="timeline">Timeline</ToggleGroupItem><ToggleGroupItem value="frame">Frame Report</ToggleGroupItem>
      </ToggleGroup>
      <div className="min-h-0 flex-1"><PanelFrame data-testid="session-diagnostic-results">
        {state.result?.kind === "profile" && state.view !== "frame" ? state.view === "summary" ? <PerformanceSummary profile={state.result.profile} /> : <PerformanceTimeline profile={state.result.profile} />
          : state.result?.kind === "frame" && state.view === "frame" ? <FrameReportView report={state.result.report} />
            : <TraceEmptyState title="No Capture Selected" description="Explicitly record Performance or capture one frame. Opening this surface does not collect data." />}
      </PanelFrame></div>
    </DialogContent>
  </Dialog>;
}
