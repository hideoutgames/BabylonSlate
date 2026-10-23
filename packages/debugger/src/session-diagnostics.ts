import { DEFAULT_PROFILE_DURATION_MS, PERFORMANCE_TICK_COLUMNS, PerformanceRecorder, type PerformanceFrameSample, type PerformanceGpuSample,
  type PerformanceIdentity, type PerformanceLongTaskSample, type PerformanceProfile, type PerformanceStopReason,
  type PerformanceTickSample } from "./performance-recorder";
import { STATS_COMMAND_INTERVAL_MS } from "./stats";

const TICK_ROW_WIDTH = PERFORMANCE_TICK_COLUMNS.length;

export type DiagnosticOperationRequest = {
  kind: "profile" | "frame"; action: "start" | "stop"; recordingId: string;
  durationMs?: number; byteBudget?: number;
};
export type DiagnosticOperationResult = { success: boolean; reason?: string };
export type SessionDiagnosticPorts<FrameReport> = {
  mode: "play" | "preview" | "simulate";
  identity: () => PerformanceIdentity;
  observeFrames: (consume: (frame: PerformanceFrameSample) => void) => () => void;
  observeGpuTiming?: (consume: (sample: PerformanceGpuSample) => void, onError: (error: unknown) => void) => {
    status: "unpaired" | "unavailable"; reason?: string; release(): void;
  };
  /** The host's accounted texture and geometry bytes, sampled at the stats rate while recording. */
  sampleMemory?: () => { textureBytes: number; geometryBytes: number };
  /** Main-thread long tasks as the browser reports them; null where it does not (Safari). */
  observeLongTasks?: (consume: (task: PerformanceLongTaskSample) => void) => (() => void) | null;
  /** Correlated runtime admission. Stop flushes accepted ticks before resolving. */
  runtimeOperation: (request: DiagnosticOperationRequest) => Promise<DiagnosticOperationResult>;
  captureFrame: (signal: AbortSignal) => Promise<FrameReport>;
  onProfile?: (profile: PerformanceProfile) => void;
  now?: () => number;
};
type Operation = {
  kind: "profile" | "frame"; id: string; abort: AbortController;
  admission: Promise<DiagnosticOperationResult>; stopping?: Promise<PerformanceProfile | null>;
  recorder?: PerformanceRecorder; releaseFrames?: () => void; releaseGpu?: () => void;
  releaseLongTasks?: () => void; memoryTimer?: ReturnType<typeof setInterval>;
  timer?: ReturnType<typeof setTimeout>; deadline?: number; sequence: number;
  droppedRecords: number;
};

/** One owner for explicit profile/frame requests. Runtime admission additionally
 * excludes a trace started by console/script, and rejects Simulation centrally. */
export class SessionDiagnostics<FrameReport> {
  private operation: Operation | undefined;
  private sequence = 0;
  private disposed = false;
  private retained: PerformanceProfile | null = null;
  private readonly now: () => number;
  private readonly ports: SessionDiagnosticPorts<FrameReport>;
  constructor(ports: SessionDiagnosticPorts<FrameReport>) {
    this.ports = ports;
    this.now = ports.now ?? (() => performance.now());
  }
  get active(): "profile" | "frame" | null { return this.operation?.kind ?? null; }
  get lastProfile(): PerformanceProfile | null { return this.retained; }
  /** Transfer owners release the player's copy after the editor has received it. */
  forgetProfile(profile: PerformanceProfile): void { if (this.retained === profile) this.retained = null; }

  async startProfile(options: { durationMs?: number; byteBudget?: number; gpuTiming?: boolean } = {}): Promise<DiagnosticOperationResult> {
    const refusal = this.refusal();
    if (refusal) return { success: false, reason: refusal };
    let identity = { ...this.ports.identity(), gpuTiming: "disabled", gpuReason: undefined, gpuAttribution: undefined } as PerformanceIdentity;
    const state = this.reserve("profile", identity.sessionId, { durationMs: options.durationMs, byteBudget: options.byteBudget });
    const result = await state.admission;
    if (!result.success || state.stopping || this.disposed) {
      if (!state.stopping) await this.finish(state, "error");
      return { success: false, reason: result.reason ?? "Performance recording was cancelled." };
    }
    try {
      const recorder = new PerformanceRecorder({ now: this.now, onStopped: (profile) => { void this.finish(state, profile.stopReason); } });
      if (options.gpuTiming) {
        const gpu = this.ports.observeGpuTiming?.(sample => {
          if (!state.stopping && this.operation === state && state.recorder) recorder.recordGpu(sample);
        }, () => { void this.finish(state, "error"); });
        state.releaseGpu = gpu?.release;
        identity = { ...identity, gpuTiming: gpu?.status ?? "unavailable",
          gpuReason: gpu?.reason ?? (gpu ? undefined : "This runtime host cannot collect GPU timing."),
          gpuAttribution: gpu?.status === "unpaired" ? "engine-aggregate" : undefined,
          enabledDiagnostics: gpu?.status === "unpaired" ? [...identity.enabledDiagnostics, "gpu-timing"] : identity.enabledDiagnostics };
      }
      if (state.stopping) throw new Error("GPU timing could not start.");
      // A sample that throws is invalid and ends the recording, as a frame's does.
      const admit = (record: () => void) => {
        if (state.stopping || this.operation !== state || !state.recorder) return;
        try { record(); } catch { void this.finish(state, "error"); }
      };
      state.releaseLongTasks = this.ports.observeLongTasks?.((task) => admit(() => recorder.recordLongTask(task))) ?? undefined;
      const sampleMemory = this.ports.sampleMemory;
      // The profile names what this host could record, so the Profiler can say what is missing.
      identity = { ...identity, enabledDiagnostics: [...identity.enabledDiagnostics,
        ...(sampleMemory ? ["memory"] : []), ...(state.releaseLongTasks ? ["long-tasks"] : [])] };
      recorder.start(identity, options);
      state.recorder = recorder;
      if (sampleMemory) {
        const sample = () => admit(() => recorder.recordMemory({ sampledAtMs: this.now(), ...sampleMemory() }));
        sample();
        state.memoryTimer = setInterval(sample, STATS_COMMAND_INTERVAL_MS);
      }
      state.deadline = this.now() + (options.durationMs ?? DEFAULT_PROFILE_DURATION_MS);
      state.releaseFrames = this.ports.observeFrames((sample) => {
        if (state.stopping || this.operation !== state) return;
        if (this.now() >= state.deadline!) { void this.finish(state, "duration"); return; }
        // An invalid sample ends the recording as an error here; a throw would only
        // detach the view's feed and leave the profile running until its deadline.
        try { recorder.recordFrame(sample); } catch { void this.finish(state, "error"); }
      });
      state.timer = setTimeout(() => { void this.finish(state, "duration"); }, options.durationMs ?? DEFAULT_PROFILE_DURATION_MS);
      this.retained = null;
      return { success: true };
    } catch (error) {
      await this.finish(state, "error");
      return { success: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  stopProfile(reason: PerformanceStopReason = "requested"): Promise<PerformanceProfile | null> {
    return this.operation?.kind === "profile" ? this.finish(this.operation, reason) : Promise.resolve(this.retained);
  }

  /** Reliable ordered chunks; gaps fail the capture rather than inventing ticks. */
  receiveTicks(message: { recordingId: string; sequence: number; rows: Float64Array; droppedRecords?: number }): boolean {
    const state = this.operation;
    if (!state || state.kind !== "profile" || state.id !== message.recordingId || !state.recorder) return false;
    if (!Number.isSafeInteger(message.sequence) || message.sequence !== state.sequence ||
      !(message.rows instanceof Float64Array) || (!message.rows.length && !message.droppedRecords) ||
      message.rows.length % TICK_ROW_WIDTH || message.rows.length > 256 * TICK_ROW_WIDTH ||
      (message.droppedRecords !== undefined && (!Number.isSafeInteger(message.droppedRecords) || message.droppedRecords < 0))) {
      void this.finish(state, "error");
      return false;
    }
    state.sequence++;
    if (Number.isSafeInteger(message.droppedRecords) && message.droppedRecords! >= 0)
      state.droppedRecords += message.droppedRecords!;
    try {
      for (let index = 0; index < message.rows.length; index += TICK_ROW_WIDTH) {
        // A budget stop counts its rejected row; the rest of the chunk is dropped too.
        if (!state.recorder.recording) { state.droppedRecords += (message.rows.length - index) / TICK_ROW_WIDTH; break; }
        const sample = {} as PerformanceTickSample;
        PERFORMANCE_TICK_COLUMNS.forEach((column, offset) => { sample[column] = message.rows[index + offset]!; });
        state.recorder.recordTick(sample, { drain: true });
      }
      return true;
    } catch { void this.finish(state, "error"); return false; }
  }

  runtimeStopped(message: { recordingId: string; reason: PerformanceStopReason }): void {
    const state = this.operation;
    if (state?.id === message.recordingId) void this.finish(state, message.reason);
  }

  async captureFrame(): Promise<FrameReport> {
    const refusal = this.refusal();
    if (refusal) throw new Error(refusal);
    const state = this.reserve("frame", this.ports.identity().sessionId, { durationMs: 10_000 });
    const result = await state.admission;
    try {
      if (!result.success || state.stopping || this.disposed) throw new Error(result.reason ?? "Frame capture was cancelled.");
      return await bounded(this.ports.captureFrame(state.abort.signal), 10_000);
    } finally { await this.finish(state, "requested"); }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.operation) await this.finish(this.operation, "session-ended");
  }
  async cancel(): Promise<void> {
    if (this.operation) await this.finish(this.operation, "requested");
  }

  private refusal(): string | null {
    if (this.disposed) return "Game session has stopped.";
    if (this.ports.mode === "simulate") return "Use Play or Preview Build to record diagnostics.";
    return this.operation ? "Stop the active diagnostic operation first." : null;
  }
  private reserve(kind: Operation["kind"], sessionId: string, options: { durationMs?: number; byteBudget?: number }): Operation {
    const id = `${sessionId}:${++this.sequence}`;
    const state: Operation = { kind, id, abort: new AbortController(), sequence: 0, droppedRecords: 0,
      admission: Promise.resolve({ success: false }) };
    this.operation = state;
    state.admission = this.request({ kind, action: "start", recordingId: id, ...options });
    return state;
  }
  private finish(state: Operation, reason: PerformanceStopReason): Promise<PerformanceProfile | null> {
    if (state.stopping) return state.stopping;
    const stoppedAt = this.now();
    state.abort.abort();
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.releaseFrames?.();
    state.releaseFrames = undefined;
    state.releaseGpu?.();
    state.releaseGpu = undefined;
    state.releaseLongTasks?.();
    state.releaseLongTasks = undefined;
    if (state.memoryTimer !== undefined) clearInterval(state.memoryTimer);
    state.stopping = (async () => {
      await state.admission;
      const released = await this.request({ kind: state.kind, action: "stop", recordingId: state.id });
      const profile = state.recorder?.stop(released.success ? reason : "error", stoppedAt) ?? null;
      if (this.operation === state) this.operation = undefined;
      if (profile) {
        profile.droppedRecords += state.droppedRecords;
        this.retained = profile;
        this.ports.onProfile?.(profile);
      }
      return profile;
    })();
    return state.stopping;
  }
  private async request(request: DiagnosticOperationRequest): Promise<DiagnosticOperationResult> {
    // Backstop for ports without their own deadline. The correlated client fails first
    // (2.5 s) with a specific reason and frees its pending slot.
    try { return await bounded(this.ports.runtimeOperation(request), 3000); }
    catch (error) { return { success: false, reason: error instanceof Error ? error.message : String(error) }; }
  }
}

async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Diagnostic operation timed out.")), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
