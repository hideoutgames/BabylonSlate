import { DEFAULT_PROFILE_DURATION_MS, PerformanceRecorder, type PerformanceFrameSample,
  type PerformanceIdentity, type PerformanceProfile, type PerformanceStopReason } from "./performance-recorder";

export type DiagnosticOperationRequest = {
  kind: "profile" | "frame"; action: "start" | "stop"; recordingId: string;
  durationMs?: number; byteBudget?: number;
};
export type DiagnosticOperationResult = { success: boolean; reason?: string };
export type SessionDiagnosticPorts<FrameReport> = {
  mode: "play" | "preview" | "simulate";
  identity: () => PerformanceIdentity;
  observeFrames: (consume: (frame: PerformanceFrameSample) => void) => () => void;
  /** Correlated runtime admission. Stop flushes accepted ticks before resolving. */
  runtimeOperation: (request: DiagnosticOperationRequest) => Promise<DiagnosticOperationResult>;
  captureFrame: (signal: AbortSignal) => Promise<FrameReport>;
  onProfile?: (profile: PerformanceProfile) => void;
  now?: () => number;
};
type Operation = {
  kind: "profile" | "frame"; id: string; abort: AbortController;
  admission: Promise<DiagnosticOperationResult>; stopping?: Promise<PerformanceProfile | null>;
  recorder?: PerformanceRecorder; releaseFrames?: () => void;
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

  async startProfile(options: { durationMs?: number; byteBudget?: number } = {}): Promise<DiagnosticOperationResult> {
    const refusal = this.refusal();
    if (refusal) return { success: false, reason: refusal };
    const identity = this.ports.identity();
    const state = this.reserve("profile", identity.sessionId, options);
    const result = await state.admission;
    if (!result.success || state.stopping || this.disposed) {
      if (!state.stopping) await this.finish(state, "error");
      return { success: false, reason: result.reason ?? "Performance recording was cancelled." };
    }
    try {
      const recorder = new PerformanceRecorder({ now: this.now, onStopped: (profile) => { void this.finish(state, profile.stopReason); } });
      recorder.start(identity, options);
      state.recorder = recorder;
      state.deadline = this.now() + (options.durationMs ?? DEFAULT_PROFILE_DURATION_MS);
      state.releaseFrames = this.ports.observeFrames((sample) => {
        if (state.stopping || this.operation !== state) return;
        if (this.now() >= state.deadline!) { void this.finish(state, "duration"); return; }
        recorder.recordFrame(sample);
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
      message.rows.length % 6 || message.rows.length > 256 * 6 ||
      (message.droppedRecords !== undefined && (!Number.isSafeInteger(message.droppedRecords) || message.droppedRecords < 0))) {
      void this.finish(state, "error");
      return false;
    }
    state.sequence++;
    if (Number.isSafeInteger(message.droppedRecords) && message.droppedRecords! >= 0)
      state.droppedRecords += message.droppedRecords!;
    try {
      for (let index = 0; index < message.rows.length; index += 6) state.recorder.recordTick({
        tickId: message.rows[index]!, elapsedMs: message.rows[index + 1]!,
        scriptMs: message.rows[index + 2]!, physicsMs: message.rows[index + 3]!,
        publishMs: message.rows[index + 4]!, otherMs: message.rows[index + 5]!,
      }, { drain: true });
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
