/** Explicit timing captures, independent of Stats and full-world traces. */
export const PERFORMANCE_FRAME_COLUMNS = [
  "frameId", "tickId", "sceneGeneration", "completedAtMs", "intervalMs",
  "preparationMs", "submissionMs", "copyMs", "drawCalls", "width", "height", "resolutionScale", "loading",
] as const;
export const PERFORMANCE_TICK_COLUMNS = [
  "tickId", "elapsedMs", "scriptMs", "physicsMs", "publishMs", "otherMs",
] as const;
export const PERFORMANCE_GPU_COLUMNS = ["observedAtMs", "durationMs", "querySequence", "coalescedQueries"] as const;
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
};
export type PerformanceStopReason = "requested" | "duration" | "budget" | "session-ended" | "error";
export type PerformanceStream = {
  columns: readonly string[];
  count: number;
  /** Interleaved rows, bounded chunks. NaN means unavailable; no repeated GPU values. */
  chunks: Float64Array[];
};
export type PerformanceProfile = {
  kind: "babylonslate-performance"; version: 1;
  identity: PerformanceIdentity;
  requestedDurationMs: number; durationMs: number;
  byteBudget: number;
  /** Accounted numeric backing buffers plus serialized metadata, not browser heap or JSON export size. */
  retainedBytes: number;
  droppedRecords: number; stopReason: PerformanceStopReason;
  frames: PerformanceStream; ticks: PerformanceStream; gpu: PerformanceStream;
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
    byteBudget: number; retainedBytes: number; previousCompletedAt: number | null;
    frames: BufferStream; ticks: BufferStream; gpu: BufferStream; previousGpuAt: number | null; previousGpuSequence: number;
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
      startedAtMs: this.now(), durationMs, byteBudget, retainedBytes, previousCompletedAt: null,
      frames: newStream(PERFORMANCE_FRAME_COLUMNS), ticks: newStream(PERFORMANCE_TICK_COLUMNS), gpu: newStream(PERFORMANCE_GPU_COLUMNS),
      previousGpuAt: null, previousGpuSequence: 0 };
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
    if (!safeId(sample.tickId) || ![sample.elapsedMs, sample.scriptMs, sample.physicsMs, sample.publishMs, sample.otherMs].every(finite))
      throw new Error("Tick samples require finite non-negative timings and a valid tick identity.");
    if (sample.elapsedMs > this.active!.durationMs) return false;
    return this.append(this.active!.ticks, PERFORMANCE_TICK_COLUMNS.map((key) => sample[key]));
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

  stop(reason: PerformanceStopReason = "requested", stoppedAtMs = this.now()): PerformanceProfile | undefined {
    const state = this.active;
    if (!state) return this.result;
    this.active = undefined;
    const finish = (stream: BufferStream): PerformanceStream => ({ columns: stream.columns, count: stream.count,
      chunks: stream.chunks.map((chunk, index) => index === stream.chunks.length - 1 ? chunk.subarray(0, stream.tailUsed) : chunk) });
    this.result = { kind: "babylonslate-performance", version: 1, identity: state.identity,
      requestedDurationMs: state.durationMs, durationMs: Math.max(0, stoppedAtMs - state.startedAtMs),
      byteBudget: state.byteBudget, retainedBytes: state.retainedBytes, droppedRecords: reason === "budget" ? 1 : 0,
      stopReason: reason, frames: finish(state.frames), ticks: finish(state.ticks), gpu: finish(state.gpu) };
    this.onStopped?.(this.result);
    return this.result;
  }

  private append(stream: BufferStream, row: number[]): boolean {
    const state = this.active!;
    let chunk = stream.chunks.at(-1);
    if (!chunk || stream.tailUsed === chunk.length) {
      const rows = Math.min(CHUNK_RECORDS, Math.floor((state.byteBudget - state.retainedBytes) / (row.length * 8)));
      if (rows === 0) { this.stop("budget"); return false; }
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
  if (data.kind !== "babylonslate-performance" || data.version !== 1 || !validIdentity(data.identity) ||
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
  const ticks = frames && parseStream(data.ticks, PERFORMANCE_TICK_COLUMNS);
  const gpu = ticks && (data.gpu === undefined ? { columns: PERFORMANCE_GPU_COLUMNS, count: 0, chunks: [] } : parseStream(data.gpu, PERFORMANCE_GPU_COLUMNS));
  if (!frames || !ticks || !gpu || bytes > data.retainedBytes || (gpu.count > 0 && data.identity.gpuTiming !== "unpaired")) return null;
  return { kind: "babylonslate-performance", version: 1, identity: copyIdentity(data.identity),
    requestedDurationMs: data.requestedDurationMs, durationMs: data.durationMs,
    byteBudget: data.byteBudget, retainedBytes: data.retainedBytes,
    droppedRecords: data.droppedRecords, stopReason: data.stopReason, frames, ticks, gpu };
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
