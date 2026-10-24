/** Explicit timing captures, independent of Stats and full-world traces. */
export const PERFORMANCE_FRAME_COLUMNS = [
  "frameId", "tickId", "sceneGeneration", "completedAtMs", "intervalMs",
  "preparationMs", "submissionMs", "copyMs", "drawCalls", "width", "height", "resolutionScale", "loading",
] as const;
/** The runtime tick's timed phases in tick order (`TickPipeline`); each one's column is `<phase>Ms`. */
export const TICK_TIMING_PHASES = [
  "gameInstance", "sceneSubsystems", "actors", "components", "physics", "postPhysics", "sceneSystems",
] as const;
export type TickTimingPhase = (typeof TICK_TIMING_PHASES)[number];
/** Display names for the timed tick phases. */
export const TICK_TIMING_PHASE_LABELS: Readonly<Record<TickTimingPhase, string>> = {
  gameInstance: "Game Instance",
  sceneSubsystems: "Scene Subsystems",
  actors: "Actors",
  components: "Components",
  physics: "Physics",
  postPhysics: "Post-Physics",
  sceneSystems: "Scene Systems",
};
/** Version 1 tick rows: script is every phase but physics. */
export const PERFORMANCE_TICK_COLUMNS_V1 = [
  "tickId", "elapsedMs", "scriptMs", "physicsMs", "publishMs", "otherMs",
] as const;
/** The phases version 2 adds; physics already has its column. */
export const PERFORMANCE_TICK_PHASE_COLUMNS = [
  "gameInstanceMs", "sceneSubsystemsMs", "actorsMs", "componentsMs", "postPhysicsMs", "sceneSystemsMs",
] as const;
/** Version 2 keeps version 1's columns first (script still sums every phase but physics). */
export const PERFORMANCE_TICK_COLUMNS = [...PERFORMANCE_TICK_COLUMNS_V1, ...PERFORMANCE_TICK_PHASE_COLUMNS] as const;
export const PERFORMANCE_GPU_COLUMNS = ["observedAtMs", "durationMs", "querySequence", "coalescedQueries"] as const;
/** Version 3: the host's accounted texture and geometry memory, sampled while recording. */
export const PERFORMANCE_MEMORY_COLUMNS = ["sampledAtMs", "textureBytes", "geometryBytes"] as const;
/** Version 3: main-thread tasks of 50 ms or more, where the browser reports them (not Safari). */
export const PERFORMANCE_LONG_TASK_COLUMNS = ["startedAtMs", "durationMs"] as const;
/**
 * Version 4: per tick, one row for each script entry point that ran: how often and for how long, not
 * counting the entry points it called. `entry` indexes the profile's `scriptEntries`.
 */
export const PERFORMANCE_SCRIPT_COLUMNS = ["tickId", "entry", "calls", "totalMs"] as const;
/** The most script entries a profile names. */
export const MAX_PERFORMANCE_SCRIPT_ENTRIES = 1024;
export const DEFAULT_PROFILE_DURATION_MS = 10_000;
export const DEFAULT_PROFILE_BYTE_BUDGET = 16 * 1024 * 1024;
export const MAX_PROFILE_BYTE_BUDGET = 64 * 1024 * 1024;
const CHUNK_RECORDS = 256;
const MAX_METADATA_BYTES = 64 * 1024;

export type PerformanceIdentity = {
  sessionId: string;
  mode: "play" | "preview" | "simulate";
  sourceSha: string | null;
  buildId: string | null;
  sceneId: string;
  backend: string;
  renderPath: string;
  runtimeHost: "worker" | "in-process";
  quality: string;
  frameCap: number | null;
  dynamicResolution: boolean;
  enabledDiagnostics: string[];
  /** A valid-query population, never fabricated per-frame alignment. */
  gpuTiming: "unavailable" | "disabled" | "unpaired";
  gpuReason?: string;
  gpuAttribution?: "engine-aggregate";
};
export type PerformanceFrameSample = {
  frameId: number; tickId: number; sceneGeneration: number;
  /** Host performance.now(), converted to a recording-relative origin on admission. */
  completedAtMs: number;
  preparationMs: number; submissionMs: number; copyMs: number; drawCalls: number;
  width: number; height: number; resolutionScale: number;
  loading?: boolean;
};
export type PerformanceGpuSample = {
  observedAtMs: number; durationMs: number; querySequence: number; coalescedQueries: number;
  attribution: "engine-aggregate";
};
export type PerformanceTickSample = {
  tickId: number;
  /** Runtime-local recording origin; never subtracted from host completion timestamps. */
  elapsedMs: number;
  scriptMs: number; physicsMs: number; publishMs: number; otherMs: number;
} & Record<(typeof PERFORMANCE_TICK_PHASE_COLUMNS)[number], number>;
/** Host performance.now(), converted to a recording-relative origin on admission. */
export type PerformanceMemorySample = { sampledAtMs: number; textureBytes: number; geometryBytes: number };
/** Host performance.now() start, converted to a recording-relative origin on admission. */
export type PerformanceLongTaskSample = { startedAtMs: number; durationMs: number };
/** A script entry point a profile timed: the Class, the event or function, and where its entry node is. */
export type PerformanceScriptEntry = {
  assetGuid: string; classId: string; className?: string;
  /** The compiled export the runtime called. */
  exportName: string; event?: string;
  /** The entry node's canvas title (`Event Tick`), or the function's name. */
  title?: string;
  graphId?: string; nodeId?: string;
};
export type PerformanceStopReason = "requested" | "duration" | "budget" | "session-ended" | "error";
export type PerformanceStream = {
  columns: readonly string[];
  count: number;
  /** Interleaved rows, bounded chunks. NaN means unavailable; no repeated GPU values. */
  chunks: Float64Array[];
};
export type PerformanceProfile = {
  /**
   * Version 1 profiles keep their tick rows (`PERFORMANCE_TICK_COLUMNS_V1`); version 2 adds the tick phases;
   * version 3 adds memory and long tasks; recordings write version 4, which adds script costs. Each addition
   * is empty when opening an earlier version.
   */
  kind: "haptic-performance"; version: 1 | 2 | 3 | 4;
  identity: PerformanceIdentity;
  requestedDurationMs: number; durationMs: number;
  byteBudget: number;
  /** Accounted numeric backing buffers plus serialized metadata, not browser heap or JSON export size. */
  retainedBytes: number;
  droppedRecords: number; stopReason: PerformanceStopReason;
  frames: PerformanceStream; ticks: PerformanceStream; gpu: PerformanceStream;
  memory: PerformanceStream; longTasks: PerformanceStream;
  scripts: PerformanceStream; scriptEntries: PerformanceScriptEntry[];
};

type BufferStream = PerformanceStream & { tailUsed: number };
const newStream = (columns: readonly string[]): BufferStream => ({ columns, count: 0, chunks: [], tailUsed: 0 });
const finite = (value: number) => Number.isFinite(value) && value >= 0;
const safeId = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** No timer, observer or allocation until start. The session owner calls advance
 * at its finite timeout too, so an idle/paused scene still ends the recording. */
export class PerformanceRecorder {
  private active: {
    identity: PerformanceIdentity; startedAtMs: number; durationMs: number;
    byteBudget: number; retainedBytes: number; previousCompletedAt: number | null; droppedRecords: number;
    frames: BufferStream; ticks: BufferStream; gpu: BufferStream; previousGpuAt: number | null; previousGpuSequence: number;
    memory: BufferStream; previousMemoryAt: number | null; longTasks: BufferStream;
    scripts: BufferStream; scriptEntries: PerformanceScriptEntry[];
  } | undefined;
  private result: PerformanceProfile | undefined;
  private readonly now: () => number;
  private readonly onStopped: ((profile: PerformanceProfile) => void) | undefined;

  constructor(options: { now?: () => number; onStopped?: (profile: PerformanceProfile) => void } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.onStopped = options.onStopped;
  }
  get recording(): boolean { return this.active !== undefined; }

  start(identity: PerformanceIdentity, options: { durationMs?: number; byteBudget?: number } = {}): void {
    if (this.active) throw new Error("A performance recording is already active.");
    if (identity.mode === "simulate") throw new Error("Use Play or Preview Build for Performance recording.");
    if (!validIdentity(identity)) throw new Error("Invalid performance recording identity.");
    const durationMs = options.durationMs ?? DEFAULT_PROFILE_DURATION_MS;
    const byteBudget = options.byteBudget ?? DEFAULT_PROFILE_BYTE_BUDGET;
    if (!finite(durationMs) || durationMs < 1000 || durationMs > 60_000)
      throw new Error("Performance recording duration must be 1–60 seconds.");
    const retainedBytes = metadataBytes(identity) + 1024;
    if (!Number.isSafeInteger(byteBudget) || byteBudget < retainedBytes + 8 * PERFORMANCE_FRAME_COLUMNS.length || byteBudget > MAX_PROFILE_BYTE_BUDGET)
      throw new Error("Performance retained-data budget cannot admit metadata and one frame.");
    this.active = { identity: copyIdentity(identity),
      startedAtMs: this.now(), durationMs, byteBudget, retainedBytes, previousCompletedAt: null, droppedRecords: 0,
      frames: newStream(PERFORMANCE_FRAME_COLUMNS), ticks: newStream(PERFORMANCE_TICK_COLUMNS), gpu: newStream(PERFORMANCE_GPU_COLUMNS),
      previousGpuAt: null, previousGpuSequence: 0,
      memory: newStream(PERFORMANCE_MEMORY_COLUMNS), previousMemoryAt: null, longTasks: newStream(PERFORMANCE_LONG_TASK_COLUMNS),
      scripts: newStream(PERFORMANCE_SCRIPT_COLUMNS), scriptEntries: [] };
    this.result = undefined;
  }

  advance(): boolean {
    if (this.active && this.now() - this.active.startedAtMs >= this.active.durationMs) this.stop("duration");
    return this.recording;
  }

  recordFrame(sample: PerformanceFrameSample): boolean {
    if (!this.advance()) return false;
    const state = this.active!;
    if (![sample.frameId, sample.tickId, sample.sceneGeneration, sample.drawCalls, sample.width, sample.height].every(safeId) ||
      ![sample.completedAtMs, sample.preparationMs, sample.submissionMs, sample.copyMs, sample.resolutionScale].every(finite) ||
      sample.completedAtMs < state.startedAtMs || (state.previousCompletedAt !== null && sample.completedAtMs < state.previousCompletedAt))
      throw new Error("Frame samples require finite, monotonic timings and valid identities.");
    const accepted = this.append(state.frames, [sample.frameId, sample.tickId, sample.sceneGeneration,
      sample.completedAtMs - state.startedAtMs,
      state.previousCompletedAt === null ? NaN : sample.completedAtMs - state.previousCompletedAt,
      sample.preparationMs, sample.submissionMs, sample.copyMs, sample.drawCalls,
      sample.width, sample.height, sample.resolutionScale, sample.loading ? 1 : 0]);
    if (accepted) state.previousCompletedAt = sample.completedAtMs;
    return accepted;
  }

  /** drain accepts already-recorded runtime chunks while a correlated Stop is
   * flushing. The session owner must stop new frames and enforce its deadline. */
  recordTick(sample: PerformanceTickSample, options: { drain?: boolean } = {}): boolean {
    if (!(options.drain ? this.recording : this.advance())) return false;
    if (!safeId(sample.tickId) || !PERFORMANCE_TICK_COLUMNS.every((column) => column === "tickId" || finite(sample[column])))
      throw new Error("Tick samples require finite non-negative timings and a valid tick identity.");
    // A tick stamped past the window is outside the profile, so it counts as dropped.
    if (sample.elapsedMs > this.active!.durationMs) { this.active!.droppedRecords++; return false; }
    return this.append(this.active!.ticks, PERFORMANCE_TICK_COLUMNS.map((key) => sample[key]));
  }

  /** The script entries a runtime chunk names first; they count toward the retained budget. */
  recordScriptEntries(entries: readonly PerformanceScriptEntry[], options: { drain?: boolean } = {}): boolean {
    if (!(options.drain ? this.recording : this.advance())) return false;
    const state = this.active!;
    if (state.scriptEntries.length + entries.length > MAX_PERFORMANCE_SCRIPT_ENTRIES || !entries.every(validScriptEntry))
      throw new Error("Script entries must be named and fit the profile's entry limit.");
    const bytes = entries.reduce((sum, entry) => sum + scriptEntryBytes(entry), 0);
    if (state.retainedBytes + bytes > state.byteBudget) { state.droppedRecords++; this.stop("budget"); return false; }
    state.retainedBytes += bytes;
    state.scriptEntries.push(...entries.map(copyScriptEntry));
    return true;
  }

  /** One entry point's calls and time in a tick the profile kept. */
  recordScript(row: { tickId: number; entry: number; calls: number; totalMs: number }, options: { drain?: boolean } = {}): boolean {
    if (!(options.drain ? this.recording : this.advance())) return false;
    const state = this.active!;
    if (!safeId(row.tickId) || !safeId(row.entry) || row.entry >= state.scriptEntries.length || !safeId(row.calls) || !finite(row.totalMs))
      throw new Error("Script rows require a valid tick, a named entry, a call count and a finite time.");
    return this.append(state.scripts, [row.tickId, row.entry, row.calls, row.totalMs]);
  }

  recordGpu(sample: PerformanceGpuSample): boolean {
    if (!this.advance()) return false;
    const state = this.active!;
    if (state.identity.gpuTiming !== "unpaired") return false;
    if (![sample.observedAtMs, sample.durationMs].every(finite) ||
      ![sample.querySequence, sample.coalescedQueries].every(safeId) || sample.attribution !== "engine-aggregate" ||
      sample.observedAtMs < state.startedAtMs || (state.previousGpuAt !== null && sample.observedAtMs < state.previousGpuAt))
      throw new Error("GPU samples require valid query identities and finite monotonic delivery times.");
    if (sample.querySequence <= state.previousGpuSequence) return false;
    const accepted = this.append(state.gpu, [sample.observedAtMs - state.startedAtMs, sample.durationMs, sample.querySequence, sample.coalescedQueries]);
    if (accepted) { state.previousGpuAt = sample.observedAtMs; state.previousGpuSequence = sample.querySequence; }
    return accepted;
  }

  recordMemory(sample: PerformanceMemorySample): boolean {
    if (!this.advance()) return false;
    const state = this.active!;
    if (![sample.sampledAtMs, sample.textureBytes, sample.geometryBytes].every(finite) ||
      sample.sampledAtMs < state.startedAtMs || (state.previousMemoryAt !== null && sample.sampledAtMs < state.previousMemoryAt))
      throw new Error("Memory samples require finite, monotonic times and non-negative byte counts.");
    const accepted = this.append(state.memory, [sample.sampledAtMs - state.startedAtMs, sample.textureBytes, sample.geometryBytes]);
    if (accepted) state.previousMemoryAt = sample.sampledAtMs;
    return accepted;
  }

  /** The browser reports a long task after it ends, so one that started before the recording is left out. */
  recordLongTask(sample: PerformanceLongTaskSample): boolean {
    if (!this.advance()) return false;
    const state = this.active!;
    if (![sample.startedAtMs, sample.durationMs].every(finite)) throw new Error("Long tasks require a finite start and duration.");
    if (sample.startedAtMs < state.startedAtMs) return false;
    return this.append(state.longTasks, [sample.startedAtMs - state.startedAtMs, sample.durationMs]);
  }

  stop(reason: PerformanceStopReason = "requested", stoppedAtMs = this.now()): PerformanceProfile | undefined {
    const state = this.active;
    if (!state) return this.result;
    this.active = undefined;
    const finish = (stream: BufferStream): PerformanceStream => ({ columns: stream.columns, count: stream.count,
      chunks: stream.chunks.map((chunk, index) => index === stream.chunks.length - 1 ? chunk.subarray(0, stream.tailUsed) : chunk) });
    this.result = { kind: "haptic-performance", version: 4, identity: state.identity,
      requestedDurationMs: state.durationMs, durationMs: Math.max(0, stoppedAtMs - state.startedAtMs),
      byteBudget: state.byteBudget, retainedBytes: state.retainedBytes, droppedRecords: state.droppedRecords,
      stopReason: reason, frames: finish(state.frames), ticks: finish(state.ticks), gpu: finish(state.gpu),
      memory: finish(state.memory), longTasks: finish(state.longTasks),
      scripts: finish(state.scripts), scriptEntries: state.scriptEntries };
    this.onStopped?.(this.result);
    return this.result;
  }

  private append(stream: BufferStream, row: number[]): boolean {
    const state = this.active!;
    let chunk = stream.chunks.at(-1);
    if (!chunk || stream.tailUsed === chunk.length) {
      const rows = Math.min(CHUNK_RECORDS, Math.floor((state.byteBudget - state.retainedBytes) / (row.length * 8)));
      if (rows === 0) { state.droppedRecords++; this.stop("budget"); return false; }
      chunk = new Float64Array(rows * row.length);
      stream.chunks.push(chunk);
      stream.tailUsed = 0;
      state.retainedBytes += chunk.byteLength;
    }
    chunk.set(row, stream.tailUsed);
    stream.tailUsed += row.length;
    stream.count++;
    return true;
  }
}

export function summarizePerformanceColumn(stream: PerformanceStream, column: string, budgetMs?: number) {
  return summarizePerformanceColumns(stream, [column], budgetMs);
}

/** Sum measured sequential phases within each row, never independent streams. */
export function summarizePerformanceColumns(stream: PerformanceStream, columns: readonly string[], budgetMs?: number) {
  const indices = columns.map(column => stream.columns.indexOf(column));
  const values: number[] = [];
  if (indices.length && indices.every(index => index >= 0)) for (const chunk of stream.chunks)
    for (let offset = 0; offset < chunk.length; offset += stream.columns.length) {
      const sum = indices.reduce((value, index) => value + chunk[offset + index]!, 0);
      if (Number.isFinite(sum)) values.push(sum);
    }
  values.sort((a, b) => a - b);
  const count = values.length;
  // Nearest rank for tail percentiles; median averages the two middle samples.
  return { count,
    median: count ? (values[Math.floor((count - 1) / 2)]! + values[Math.floor(count / 2)]!) / 2 : null,
    p95: count ? values[Math.ceil(count * 0.95) - 1]! : null,
    p99: count ? values[Math.ceil(count * 0.99) - 1]! : null,
    maximum: count ? values[count - 1]! : null,
    overBudgetCount: budgetMs === undefined ? null : values.filter((value) => value > budgetMs).length };
}

/** Explicit export only. Numeric retained bytes do not bound this JSON string's size. */
export function serializePerformanceProfile(profile: PerformanceProfile): string {
  return JSON.stringify(profile, (_key, value: unknown) => value instanceof Float64Array ? Array.from(value, (number) => Number.isNaN(number) ? null : number) : value);
}

export function parsePerformanceProfile(value: unknown): PerformanceProfile | null {
  if (!value || typeof value !== "object") return null;
  const data = value as PerformanceProfile;
  if (data.kind !== "haptic-performance" || ![1, 2, 3, 4].includes(data.version) || !validIdentity(data.identity) ||
    data.identity.mode === "simulate" || !finite(data.durationMs) || !finite(data.requestedDurationMs) ||
    data.requestedDurationMs < 1000 || data.requestedDurationMs > 60_000 ||
    !safeId(data.byteBudget) || data.byteBudget > MAX_PROFILE_BYTE_BUDGET || !safeId(data.retainedBytes) ||
    data.retainedBytes > data.byteBudget || !safeId(data.droppedRecords) ||
    !["requested", "duration", "budget", "session-ended", "error"].includes(data.stopReason)) return null;
  let bytes = metadataBytes(data.identity) + 1024;
  const parseStream = (input: PerformanceStream, columns: readonly string[]): PerformanceStream | null => {
    if (!input || !Array.isArray(input.columns) || input.columns.length !== columns.length ||
      input.columns.some((column, index) => column !== columns[index]) || !safeId(input.count) || !Array.isArray(input.chunks)) return null;
    let count = 0;
    for (const chunk of input.chunks) {
      if ((!Array.isArray(chunk) && !(chunk instanceof Float64Array)) || !chunk.length || chunk.length % columns.length || chunk.length > CHUNK_RECORDS * columns.length) return null;
      bytes += chunk.length * 8;
      if (bytes > data.byteBudget || !chunk.every((number: unknown, index: number) =>
        number === null || (typeof number === "number" && Number.isNaN(number))
          ? columns[index % columns.length] === "intervalMs" : typeof number === "number" && finite(number))) return null;
      count += chunk.length / columns.length;
    }
    if (count !== input.count) return null;
    return { columns, count, chunks: input.chunks.map((chunk) => chunk instanceof Float64Array
      ? chunk : Float64Array.from(chunk, (number) => number === null ? NaN : Number(number))) };
  };
  const frames = parseStream(data.frames, PERFORMANCE_FRAME_COLUMNS);
  const ticks = frames && parseStream(data.ticks, data.version === 1 ? PERFORMANCE_TICK_COLUMNS_V1 : PERFORMANCE_TICK_COLUMNS);
  const gpu = ticks && parseStream(data.gpu, PERFORMANCE_GPU_COLUMNS);
  // Earlier versions recorded neither, so they open with both empty.
  const emptyStream = (columns: readonly string[]): PerformanceStream => ({ columns, count: 0, chunks: [] });
  const memory = gpu && (data.version >= 3 ? parseStream(data.memory, PERFORMANCE_MEMORY_COLUMNS) : emptyStream(PERFORMANCE_MEMORY_COLUMNS));
  const longTasks = memory && (data.version >= 3 ? parseStream(data.longTasks, PERFORMANCE_LONG_TASK_COLUMNS) : emptyStream(PERFORMANCE_LONG_TASK_COLUMNS));
  const entries = data.version >= 4 ? data.scriptEntries : [];
  if (!Array.isArray(entries) || entries.length > MAX_PERFORMANCE_SCRIPT_ENTRIES || !entries.every(validScriptEntry)) return null;
  bytes += entries.reduce((sum, entry) => sum + scriptEntryBytes(entry), 0);
  const scripts = longTasks && (data.version >= 4 ? parseStream(data.scripts, PERFORMANCE_SCRIPT_COLUMNS) : emptyStream(PERFORMANCE_SCRIPT_COLUMNS));
  if (!frames || !ticks || !gpu || !memory || !longTasks || !scripts || bytes > data.retainedBytes ||
    (gpu.count > 0 && data.identity.gpuTiming !== "unpaired") || !scriptRowsNameEntries(scripts, entries.length)) return null;
  return { kind: "haptic-performance", version: data.version, identity: copyIdentity(data.identity),
    requestedDurationMs: data.requestedDurationMs, durationMs: data.durationMs,
    byteBudget: data.byteBudget, retainedBytes: data.retainedBytes,
    droppedRecords: data.droppedRecords, stopReason: data.stopReason, frames, ticks, gpu, memory, longTasks,
    scripts, scriptEntries: entries.map(copyScriptEntry) };
}

const SCRIPT_ENTRY_TEXT = ["assetGuid", "classId", "exportName", "className", "event", "title", "graphId", "nodeId"] as const;
function validScriptEntry(value: unknown): value is PerformanceScriptEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return SCRIPT_ENTRY_TEXT.every((key) => {
    const text = entry[key];
    const required = key === "assetGuid" || key === "classId" || key === "exportName";
    return text === undefined ? !required : typeof text === "string" && text.length <= 1024;
  });
}
/** Known fields only, so extra imported fields neither count nor survive. */
function copyScriptEntry(entry: PerformanceScriptEntry): PerformanceScriptEntry {
  return Object.fromEntries(SCRIPT_ENTRY_TEXT.flatMap((key) => entry[key] === undefined ? [] : [[key, entry[key]]])) as PerformanceScriptEntry;
}
function scriptEntryBytes(entry: PerformanceScriptEntry): number {
  return new TextEncoder().encode(JSON.stringify(copyScriptEntry(entry))).byteLength;
}
function scriptRowsNameEntries(stream: PerformanceStream, entries: number): boolean {
  const width = PERFORMANCE_SCRIPT_COLUMNS.length;
  return stream.chunks.every((chunk) => {
    for (let offset = 1; offset < chunk.length; offset += width) if (!Number.isSafeInteger(chunk[offset]) || chunk[offset]! >= entries) return false;
    return true;
  });
}

function validIdentity(value: unknown): value is PerformanceIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as PerformanceIdentity;
  if (!["play", "preview", "simulate"].includes(identity.mode) ||
    !["worker", "in-process"].includes(identity.runtimeHost) ||
    !["disabled", "unavailable", "unpaired"].includes(identity.gpuTiming) ||
    (identity.gpuReason !== undefined && (typeof identity.gpuReason !== "string" || identity.gpuReason.length > 4096)) ||
    (identity.gpuAttribution !== undefined && identity.gpuAttribution !== "engine-aggregate") ||
    (identity.gpuTiming === "unpaired" && identity.gpuAttribution !== "engine-aggregate") ||
    typeof identity.dynamicResolution !== "boolean" ||
    !(identity.frameCap === null || finite(identity.frameCap)) ||
    !Array.isArray(identity.enabledDiagnostics) || identity.enabledDiagnostics.length > 32 ||
    !identity.enabledDiagnostics.every((item) => typeof item === "string" && item.length <= 256)) return false;
  for (const key of ["sessionId", "sceneId", "backend", "renderPath", "quality", "sourceSha", "buildId"] as const) {
    const field = identity[key];
    if ((key === "sourceSha" || key === "buildId") && field === null) continue;
    if (typeof field !== "string" || field.length > (key === "quality" ? 32_768 : 4096)) return false;
  }
  return metadataBytes(identity) <= MAX_METADATA_BYTES;
}
function metadataBytes(identity: PerformanceIdentity): number {
  // Select known bounded fields so imported extra fields cannot inflate retained metadata.
  return new TextEncoder().encode(JSON.stringify(copyIdentity(identity))).byteLength;
}
function copyIdentity(identity: PerformanceIdentity): PerformanceIdentity {
  const { sessionId, mode, sourceSha, buildId, sceneId, backend, renderPath, runtimeHost,
    quality, frameCap, dynamicResolution, enabledDiagnostics, gpuTiming, gpuReason, gpuAttribution } = identity;
  return { sessionId, mode, sourceSha, buildId, sceneId, backend, renderPath, runtimeHost,
    quality, frameCap, dynamicResolution, enabledDiagnostics: [...enabledDiagnostics], gpuTiming,
    ...(gpuReason !== undefined ? { gpuReason } : {}), ...(gpuAttribution !== undefined ? { gpuAttribution } : {}) };
}
