import { TICK_TIMING_PHASES, type TickTimingPhase } from "./performance-recorder";

/** Combined script + physics tick budget from engineplan §1.2 (milliseconds). */
export const TICK_BUDGET_MS = 8;

/** Play/export HUD stats channel rate so measuring does not perturb the tick. */
export const STATS_COMMAND_INTERVAL_MS = 200;

export function isTickOverBudget(
  scriptMs: number,
  physicsMs: number,
  budgetMs: number = TICK_BUDGET_MS,
): boolean {
  return scriptMs + physicsMs > budgetMs;
}

/** First sample always; then at most one stats command per interval. */
export function shouldEmitStatsCommand(
  nowMs: number,
  lastEmitMs: number | null,
  intervalMs: number = STATS_COMMAND_INTERVAL_MS,
): boolean {
  if (lastEmitMs === null) return true;
  return nowMs - lastEmitMs >= intervalMs;
}

/** Optional Stats rows enabled with `stat <group>`; FPS and tick timings always show. */
export const STAT_GROUPS = ["unit", "memory", "draws", "threads"] as const;
export type StatGroup = (typeof STAT_GROUPS)[number];

export const STAT_GROUP_LABELS: Readonly<Record<StatGroup, string>> = {
  unit: "Unit",
  memory: "Memory",
  draws: "Render",
  threads: "Threads",
};

export function isStatGroup(name: unknown): name is StatGroup {
  return typeof name === "string" && (STAT_GROUPS as readonly string[]).includes(name);
}

/** Groups after `stat <name> on|off`, in display order; unknown names change nothing. */
export function nextStatGroups(
  groups: readonly StatGroup[],
  name: unknown,
  enabled: boolean,
): readonly StatGroup[] {
  if (!isStatGroup(name)) return groups;
  return STAT_GROUPS.filter((group) => group === name ? enabled : groups.includes(group));
}

/** The render timings Stats shows; a render package `RenderDiagnostics` satisfies it. */
export type StatsHudRendering = {
  cpuMs: number;
  gpuMs: number | null;
  gpuStatus: string;
  width: number;
  height: number;
  shadowDrawCalls: number;
  readbackMs: number | null;
  autoLod: { meshes: number; reduced: number };
  qualityLimits: readonly string[];
};

/** What a host knows; an absent value leaves its metric out. */
export type StatsHudInput = {
  fps: number;
  scriptMs: number;
  physicsMs: number;
  /** Snapshot publish ms, apart from the script/physics tick budget. */
  publishMs?: number;
  /** The last tick's ms per timed phase, in `TICK_TIMING_PHASES` order; `stat unit` lists them. */
  phaseMs?: readonly number[];
  /** Accounted texture bytes in the resource cache. */
  memoryBytes?: number;
  jsHeapBytes?: number;
  appFootprintBytes?: number;
  appAvailableBytes?: number;
  systemAvailableBytes?: number;
  geometryBytes?: number;
  /** Geometry bytes are past the render package's ceiling warning. */
  geometryHigh?: boolean;
  draws?: number;
  /** Draw calls are past the render package's ceiling warning. */
  drawsHigh?: boolean;
  meshCount?: number;
  textureCount?: number;
  rendering?: StatsHudRendering;
  bridgeMessagesPerSec?: number;
  liveActors?: number;
  snapshotCapacity?: number;
  ticks?: number;
};

export type StatsHudMetric = {
  /** Stable across hosts; renderers derive their test hooks from it. */
  id: string;
  label?: string;
  text: string;
  /** The number behind `text`, for hooks that read it. */
  raw?: number;
  warn?: boolean;
};

export type StatsHudRow = {
  group: StatGroup;
  /** Empty when the host has nothing for the group; renderers show "unavailable". */
  metrics: readonly StatsHudMetric[];
};

export type StatsHudModel = {
  overBudget: boolean;
  /** Always shown after FPS: frame time and tick timings. */
  frame: readonly StatsHudMetric[];
  /** `stat <group>` rows in display order. */
  rows: readonly StatsHudRow[];
};

export function formatStatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ms = (value: number) => `${value.toFixed(2)} ms`;

/** `stat unit` labels per timed tick phase. */
const PHASE_LABELS: Readonly<Record<TickTimingPhase, string>> = {
  gameInstance: "game",
  sceneSubsystems: "subsystems",
  actors: "actors",
  components: "components",
  physics: "physics",
  postPhysics: "post-physics",
  sceneSystems: "systems",
};

function present(metrics: readonly (StatsHudMetric | null)[]): StatsHudMetric[] {
  return metrics.filter((metric): metric is StatsHudMetric => metric !== null);
}

function bytesMetric(id: string, label: string, bytes: number | undefined, warn?: boolean): StatsHudMetric | null {
  return bytes == null ? null : { id, label, text: formatStatBytes(bytes), raw: bytes, ...(warn ? { warn } : {}) };
}

function groupMetrics(group: StatGroup, input: StatsHudInput, overBudget: boolean): StatsHudMetric[] {
  switch (group) {
    case "unit":
      return present([
        { id: "tick", label: "tick", text: `${(input.scriptMs + input.physicsMs).toFixed(2)} / ${TICK_BUDGET_MS} ms`, warn: overBudget },
        ...(input.phaseMs?.length === TICK_TIMING_PHASES.length
          ? TICK_TIMING_PHASES.map((phase, index) => {
            const value = input.phaseMs![index]!;
            return { id: `phase-${phase}`, label: PHASE_LABELS[phase], text: ms(value), raw: value };
          })
          : []),
        input.publishMs == null ? null : { id: "publish-ms", label: "publish", text: ms(input.publishMs), raw: input.publishMs },
      ]);
    case "memory":
      return present([
        bytesMetric("memory", "mem", input.memoryBytes),
        bytesMetric("js-heap", "js", input.jsHeapBytes),
        bytesMetric("app-footprint", "app", input.appFootprintBytes),
        bytesMetric("app-headroom", "headroom", input.appAvailableBytes),
        bytesMetric("system-memory", "free", input.systemAvailableBytes),
        bytesMetric("geo", "geo", input.geometryBytes, input.geometryHigh),
      ]);
    case "draws": {
      const rendering = input.rendering;
      return present([
        input.draws == null ? null : { id: "draws", label: "draws", text: String(input.draws), raw: input.draws, warn: input.drawsHigh === true },
        input.meshCount == null ? null : { id: "meshes", label: "meshes", text: String(input.meshCount), raw: input.meshCount },
        input.textureCount == null ? null : { id: "textures", label: "tex", text: String(input.textureCount), raw: input.textureCount },
        ...(rendering ? [
          { id: "cpu", label: "cpu", text: ms(rendering.cpuMs), raw: rendering.cpuMs },
          { id: "gpu", label: "gpu", text: rendering.gpuMs === null ? rendering.gpuStatus : ms(rendering.gpuMs), ...(rendering.gpuMs === null ? {} : { raw: rendering.gpuMs }) },
          { id: "resolution", text: `${rendering.width}×${rendering.height}` },
          { id: "shadows", label: "shadows", text: `${rendering.shadowDrawCalls} draws`, raw: rendering.shadowDrawCalls },
          rendering.readbackMs === null ? null : { id: "readback", label: "readback", text: ms(rendering.readbackMs), raw: rendering.readbackMs },
          rendering.autoLod.meshes ? { id: "lod", label: "lod", text: `${rendering.autoLod.reduced}/${rendering.autoLod.meshes}` } : null,
          rendering.qualityLimits.length ? { id: "quality-limits", text: rendering.qualityLimits.join(", "), warn: true } : null,
        ] : []),
        input.drawsHigh ? { id: "draw-warn", text: "draws high", warn: true } : null,
        input.geometryHigh ? { id: "geo-warn", text: "geo high", warn: true } : null,
      ]);
    }
    case "threads":
      return present([
        input.bridgeMessagesPerSec == null ? null : { id: "bridge", label: "bridge", text: `${input.bridgeMessagesPerSec}/s`, raw: input.bridgeMessagesPerSec },
        input.liveActors == null ? null : {
          id: "actors",
          label: "actors",
          text: input.snapshotCapacity == null ? String(input.liveActors) : `${input.liveActors}/${input.snapshotCapacity}`,
          raw: input.liveActors,
        },
        input.ticks == null ? null : { id: "ticks", label: "ticks", text: String(input.ticks), raw: input.ticks },
      ]);
  }
}

/** Stats as every host shows it: FPS, the frame row, then one row per enabled `stat` group. */
export function statsHudModel(input: StatsHudInput, groups: readonly StatGroup[]): StatsHudModel {
  const overBudget = isTickOverBudget(input.scriptMs, input.physicsMs);
  return {
    overBudget,
    frame: present([
      { id: "frame-ms", text: input.fps > 0 ? `${(1000 / input.fps).toFixed(1)} ms` : "— ms" },
      { id: "script-ms", label: "script", text: ms(input.scriptMs), raw: input.scriptMs, warn: overBudget },
      { id: "physics-ms", label: "physics", text: ms(input.physicsMs), raw: input.physicsMs, warn: overBudget },
      overBudget ? { id: "over-budget", text: `over ${TICK_BUDGET_MS} ms budget`, warn: true } : null,
    ]),
    rows: STAT_GROUPS.filter((group) => groups.includes(group))
      .map((group) => ({ group, metrics: groupMetrics(group, input, overBudget) })),
  };
}

/** Bridge messages per second, re-measured over windows of at least `windowMs`. */
export function createMessageRateMeter(now: () => number, windowMs = 200): {
  note: () => void;
  perSecond: () => number;
} {
  let count = 0;
  let windowStart = now();
  let rate = 0;
  const roll = () => {
    const time = now();
    const elapsed = time - windowStart;
    if (elapsed < windowMs) return;
    rate = (count * 1000) / elapsed;
    count = 0;
    windowStart = time;
  };
  return {
    note() {
      count += 1;
      roll();
    },
    perSecond() {
      roll();
      return Math.round(rate);
    },
  };
}
