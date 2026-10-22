import { Fragment, useEffect, useRef, useState } from "react";
import { STAT_GROUP_LABELS, statsHudModel, TICK_BUDGET_MS, type StatGroup, type StatsHudMetric } from "@babylonslate/debugger";
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
  liveActors?: number;
  snapshotCapacity?: number;
  ticks?: number;
  /** Optional rows enabled with `stat <group>`, in display order. */
  groups?: readonly StatGroup[];
  /** False while a parent keeps the HUD mounted but hidden; the `stat unit` graph stops sampling. */
  visible?: boolean;
};

type Sample = { scriptMs: number; physicsMs: number };

const SAMPLE_MS = 200;
const SAMPLE_COUNT = 40;

/** Test ids the e2e suites read; every other metric is `stats-hud-<id>`. */
const METRIC_TEST_IDS: Readonly<Record<string, string>> = {
  "frame-ms": "play-frame-ms",
  "script-ms": "play-script-ms",
  "physics-ms": "play-physics-ms",
  "publish-ms": "play-publish-ms",
};

/** Raw values the e2e suites read from data attributes. */
const METRIC_RAW_ATTRIBUTES: Readonly<Record<string, `data-${string}`>> = {
  "script-ms": "data-ms",
  "physics-ms": "data-ms",
  "publish-ms": "data-ms",
  draws: "data-draws",
};

function Metric({ metric }: { metric: StatsHudMetric }) {
  const rawAttribute = METRIC_RAW_ATTRIBUTES[metric.id];
  return (
    <span
      data-testid={METRIC_TEST_IDS[metric.id] ?? `stats-hud-${metric.id}`}
      className={cn("whitespace-nowrap", metric.warn && "text-destructive")}
      {...(rawAttribute && metric.raw !== undefined ? { [rawAttribute]: String(metric.raw) } : {})}
    >
      <SelectableText>
        {metric.label ? <span className="text-muted-foreground">{metric.label} </span> : null}
        {metric.text}
      </SelectableText>
    </span>
  );
}

function GroupRow({ group, metrics }: { group: StatGroup; metrics: readonly StatsHudMetric[] }) {
  return (
    <div className="flex items-baseline gap-3" data-testid={`stats-hud-group-${group}`}>
      <span className="w-14 shrink-0 text-muted-foreground">{STAT_GROUP_LABELS[group]}</span>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
        {metrics.length
          ? metrics.map((metric) => <Metric key={metric.id} metric={metric} />)
          : <span className="text-muted-foreground">unavailable</span>}
      </div>
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
  liveActors,
  snapshotCapacity,
  ticks,
  groups = [],
  visible = true,
}: StatsHudProps) {
  const latest = useRef({ scriptMs, physicsMs });
  latest.current = { scriptMs, physicsMs };
  const [samples, setSamples] = useState<Sample[]>([{ scriptMs, physicsMs }]);
  const showUnit = groups.includes("unit");

  useEffect(() => {
    if (!showUnit || !visible) return;
    const id = window.setInterval(() => {
      setSamples((prev) => {
        const next = [...prev, latest.current];
        return next.length > SAMPLE_COUNT ? next.slice(-SAMPLE_COUNT) : next;
      });
    }, SAMPLE_MS);
    return () => window.clearInterval(id);
  }, [showUnit, visible]);

  const model = statsHudModel({
    fps,
    scriptMs,
    physicsMs,
    publishMs,
    memoryBytes,
    jsHeapBytes: hostMemory?.jsHeapBytes,
    appFootprintBytes: hostMemory?.appFootprintBytes,
    appAvailableBytes: hostMemory?.appAvailableBytes,
    systemAvailableBytes: hostMemory?.systemAvailableBytes,
    geometryBytes,
    geometryHigh: geometryBytes != null && geometryByteCeilingWarning(geometryBytes) !== null,
    draws,
    drawsHigh: draws != null && drawCallCeilingWarning(draws) !== null,
    meshCount,
    textureCount,
    rendering,
    bridgeMessagesPerSec,
    liveActors,
    snapshotCapacity,
    ticks,
  }, groups);

  return (
    <div
      className="play-debug-readout pointer-events-none inline-flex max-w-full flex-col gap-0.5"
      data-testid="stats-hud"
      data-groups={groups.join(" ")}
    >
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span data-testid="play-fps" data-fps={String(fps)} className="whitespace-nowrap">
          <SelectableText>
            <span className="text-xs font-semibold">{fps}</span> fps
          </SelectableText>
        </span>
        {model.frame.map((metric) => <Metric key={metric.id} metric={metric} />)}
      </div>
      {model.rows.map(({ group, metrics }) => group === "unit" ? (
        <Fragment key={group}>
          {/* Tick history on its own line above the Unit row, aligned with the values. */}
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
          <GroupRow group={group} metrics={metrics} />
        </Fragment>
      ) : <GroupRow key={group} group={group} metrics={metrics} />)}
    </div>
  );
}
