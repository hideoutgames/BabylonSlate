import { useEffect, useRef, useState, type ReactNode } from "react";
import { isTickOverBudget, STAT_GROUP_LABELS, TICK_BUDGET_MS, type StatGroup } from "@babylonslate/debugger";
import type { HostMemoryStats } from "@babylonslate/vfs";
import { drawCallCeilingWarning, geometryByteCeilingWarning, type RenderDiagnostics } from "@babylonslate/render";
import { SelectableText } from "@babylonslate/editor-kit";
import { cn } from "@babylonslate/ui/lib/utils";

export type StatsHudProps = {
  fps: number;
  scriptMs: number;
  physicsMs: number;
  /** Snapshot publish ms; shown apart from the script/physics tick budget. */
  publishMs?: number;
  memoryBytes?: number;
  hostMemory?: HostMemoryStats | null;
  geometryBytes?: number;
  meshCount?: number;
  textureCount?: number;
  draws?: number;
  rendering?: RenderDiagnostics;
  bridgeMessagesPerSec?: number;
  /** Optional rows enabled with `stat <group>`, in display order. */
  groups?: readonly StatGroup[];
};

type Sample = { scriptMs: number; physicsMs: number };

const SAMPLE_MS = 200;
const SAMPLE_COUNT = 40;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Metric({ label, value, testId, tone, data }: {
  label?: string;
  value: ReactNode;
  testId?: string;
  tone?: "warn";
  data?: Record<`data-${string}`, string>;
}) {
  return (
    <span data-testid={testId} className={cn("whitespace-nowrap", tone === "warn" && "text-destructive")} {...data}>
      <SelectableText>
        {label ? <span className="text-muted-foreground">{label} </span> : null}
        {value}
      </SelectableText>
    </span>
  );
}

function GroupRow({ group, children }: { group: StatGroup; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3" data-testid={`stats-hud-group-${group}`}>
      <span className="w-14 shrink-0 text-muted-foreground">{STAT_GROUP_LABELS[group]}</span>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">{children}</div>
    </div>
  );
}

/** Play Stats: FPS and tick timings, plus rows the `stat` console commands add. */
export function StatsHud({
  fps,
  scriptMs,
  physicsMs,
  publishMs,
  memoryBytes,
  hostMemory,
  geometryBytes,
  meshCount,
  textureCount,
  draws,
  rendering,
  bridgeMessagesPerSec,
  groups = [],
}: StatsHudProps) {
  const latest = useRef({ scriptMs, physicsMs });
  latest.current = { scriptMs, physicsMs };
  const [samples, setSamples] = useState<Sample[]>([{ scriptMs, physicsMs }]);
  const showUnit = groups.includes("unit");

  useEffect(() => {
    if (!showUnit) return;
    const id = window.setInterval(() => {
      setSamples((prev) => {
        const next = [...prev, latest.current];
        return next.length > SAMPLE_COUNT ? next.slice(-SAMPLE_COUNT) : next;
      });
    }, SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [showUnit]);

  const overBudget = isTickOverBudget(scriptMs, physicsMs);
  const drawsHigh = draws != null && drawCallCeilingWarning(draws) !== null;
  const geoHigh = geometryBytes != null && geometryByteCeilingWarning(geometryBytes) !== null;
  const memoryRows = [
    memoryBytes != null ? <Metric key="mem" label="mem" value={formatBytes(memoryBytes)} testId="stats-hud-memory" /> : null,
    hostMemory?.jsHeapBytes != null ? <Metric key="js" label="js" value={formatBytes(hostMemory.jsHeapBytes)} testId="stats-hud-js-heap" /> : null,
    hostMemory?.appFootprintBytes != null ? <Metric key="app" label="app" value={formatBytes(hostMemory.appFootprintBytes)} testId="stats-hud-app-footprint" /> : null,
    hostMemory?.appAvailableBytes != null ? <Metric key="headroom" label="headroom" value={formatBytes(hostMemory.appAvailableBytes)} testId="stats-hud-app-headroom" /> : null,
    hostMemory?.systemAvailableBytes != null ? <Metric key="free" label="free" value={formatBytes(hostMemory.systemAvailableBytes)} testId="stats-hud-system-memory" /> : null,
    geometryBytes != null ? <Metric key="geo" label="geo" value={formatBytes(geometryBytes)} testId="stats-hud-geo" tone={geoHigh ? "warn" : undefined} /> : null,
  ].filter(Boolean);

  return (
    <div
      className="pointer-events-none inline-flex max-w-full flex-col gap-0.5 rounded-sm bg-background/75 px-2 py-1 font-mono text-[11px] leading-4 text-foreground backdrop-blur-sm"
      data-testid="stats-hud"
      data-groups={groups.join(" ")}
    >
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span data-testid="play-fps" data-fps={String(fps)} className="whitespace-nowrap">
          <SelectableText>
            <span className="text-xs font-semibold">{fps}</span> fps
          </SelectableText>
        </span>
        <Metric value={fps > 0 ? `${(1000 / fps).toFixed(1)} ms` : "— ms"} testId="play-frame-ms" />
        <Metric label="script" value={`${scriptMs.toFixed(2)} ms`} testId="play-script-ms" data={{ "data-ms": String(scriptMs) }} tone={overBudget ? "warn" : undefined} />
        <Metric label="physics" value={`${physicsMs.toFixed(2)} ms`} testId="play-physics-ms" data={{ "data-ms": String(physicsMs) }} tone={overBudget ? "warn" : undefined} />
        {overBudget ? <span data-testid="stats-hud-over-budget" className="whitespace-nowrap text-destructive">over {TICK_BUDGET_MS} ms budget</span> : null}
      </div>
      {showUnit ? (
        <>
          <GroupRow group="unit">
            <Metric label="tick" value={`${(scriptMs + physicsMs).toFixed(2)} / ${TICK_BUDGET_MS} ms`} tone={overBudget ? "warn" : undefined} />
            {publishMs != null ? <Metric label="publish" value={`${publishMs.toFixed(2)} ms`} testId="play-publish-ms" data={{ "data-ms": String(publishMs) }} /> : null}
          </GroupRow>
          {/* Tick history on its own line, aligned with the row values. */}
          <div className="flex h-5 items-end gap-px pl-[4.25rem]" data-testid="stats-hud-graph" aria-hidden>
            {samples.map((sample, index) => {
              const total = sample.scriptMs + sample.physicsMs;
              return (
                <span
                  key={index}
                  className={cn("w-0.5", total > TICK_BUDGET_MS ? "bg-destructive" : "bg-muted-foreground")}
                  style={{ height: `${Math.max(8, Math.min(100, (total / TICK_BUDGET_MS) * 100))}%` }}
                />
              );
            })}
          </div>
        </>
      ) : null}
      {groups.includes("memory") ? (
        <GroupRow group="memory">{memoryRows.length ? memoryRows : <span className="text-muted-foreground">unavailable</span>}</GroupRow>
      ) : null}
      {groups.includes("draws") ? (
        <GroupRow group="draws">
          {draws != null ? <Metric label="draws" value={draws} testId="stats-hud-draws" data={{ "data-draws": String(draws) }} tone={drawsHigh ? "warn" : undefined} /> : null}
          {meshCount != null ? <Metric label="meshes" value={meshCount} testId="stats-hud-meshes" /> : null}
          {textureCount != null ? <Metric label="tex" value={textureCount} testId="stats-hud-textures" /> : null}
          {rendering ? <>
            <Metric label="cpu" value={`${rendering.cpuMs.toFixed(2)} ms`} />
            <Metric label="gpu" value={rendering.gpuMs === null ? rendering.gpuStatus : `${rendering.gpuMs.toFixed(2)} ms`} />
            <Metric value={`${rendering.width}×${rendering.height}`} />
            <Metric label="shadows" value={`${rendering.shadowDrawCalls} draws`} />
            {rendering.readbackMs === null ? null : <Metric label="readback" value={`${rendering.readbackMs.toFixed(2)} ms`} />}
            {rendering.autoLod.meshes ? <Metric label="lod" value={`${rendering.autoLod.reduced}/${rendering.autoLod.meshes}`} /> : null}
            {rendering.qualityLimits.length ? <Metric value={rendering.qualityLimits.join(", ")} tone="warn" /> : null}
          </> : null}
          {drawsHigh ? <span data-testid="stats-hud-draw-warn" className="text-destructive">draws high</span> : null}
          {geoHigh ? <span data-testid="stats-hud-geo-warn" className="text-destructive">geo high</span> : null}
        </GroupRow>
      ) : null}
      {groups.includes("threads") ? (
        <GroupRow group="threads">
          {bridgeMessagesPerSec != null ? <Metric label="bridge" value={`${bridgeMessagesPerSec}/s`} testId="stats-hud-bridge" /> : <span className="text-muted-foreground">unavailable</span>}
        </GroupRow>
      ) : null}
    </div>
  );
}
