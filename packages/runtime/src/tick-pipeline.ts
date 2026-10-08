import type { CommandMessage, DiagnosticOperationRequest, DiagnosticOperationResult, GameSessionMode } from "@babylonslate/bridge";
import {
  TraceRecorder,
  isInfiniteLoopError,
  shouldEmitStatsCommand,
  type CommandResult,
  type TraceFrame,
  type TracePayload,
} from "@babylonslate/debugger";
import type { RawInputEvent } from "@babylonslate/input";
import { createWorldSnapshot, stringifyWorldSnapshot, type TickPhase, type World } from "@babylonslate/object-model";
import type { LogRingBuffer, LogSeverity } from "./log-ring";
import { RuntimeDiagnosticRecorder } from "./runtime-diagnostic-recorder";
import type { SnapshotPublisher } from "./snapshot-publisher";

/** Catch-up cap for one `advance()`: more ticks than this drop the rest of the elapsed time. */
const MAX_CATCH_UP_TICKS = 4;

interface TickPipelineHost {
  /** Running, not paused, outside a Save Game boundary and no blocking stream load. */
  canTick(): boolean;
  /** Running, not paused and no blocking stream load. */
  canAdvance(): boolean;
  paused(): boolean;
  stopped(): boolean;
  /** The tick's phases, in order; the driver stays their orchestrator. */
  runTick(): void;
  /** Apply pause changes requested while the tick ran. */
  settlePauseChanges(): void;
  /** The frame id after the completed tick's increment. */
  frameId(): number;
  liveActors(): number;
  /** Behaviour tree, voice, sprite clip and Animation Graph state that `restoreFromTrace` resumes. */
  traceState(): Required<Pick<TraceFrame, "bt" | "audio" | "sprites" | "animGraphs">>;
  reportLog(message: string, severity: LogSeverity, category: string): void;
  emit(command: CommandMessage): void;
}

interface TickPipelineOptions {
  dt: number;
  seed: number;
  generation: number;
  mode: GameSessionMode;
  diagnosticsEnabled: boolean;
  traceByteBudget?: number;
}

/**
 * The fixed-step tick's bookkeeping around the driver's phase list: the tick
 * gate and reentrancy flag, `advance()` accumulator and catch-up cap, script
 * and physics phase timing, per-tick profile samples, the throttled `stats`
 * command, trace frames and the diagnostic recorder. The driver keeps the
 * phase order inside `runTick` and calls back at its fixed points.
 */
export class TickPipeline {
  private accumulator = 0;
  private elapsedReset = false;
  private _processing = false;
  private phaseMark = 0;
  private currentTimingPhase: TickPhase | null = null;
  private phaseScriptMs = 0;
  private phasePhysicsMs = 0;
  private _lastScriptMs = 0;
  private _lastPhysicsMs = 0;
  /** Publish time spent in the current tick while a profile records. */
  private profilePublishMs = 0;
  private lastStatsEmitMs: number | null = null;
  private prints: Array<{ message: string; key: string }> = [];
  private readonly trace: TraceRecorder;
  private _lastTrace: TracePayload | null = null;
  private diagnosticRecorder: RuntimeDiagnosticRecorder | null = null;
  private readonly world: World;
  private readonly snapshots: SnapshotPublisher;
  private readonly logs: LogRingBuffer;
  private readonly host: TickPipelineHost;
  private readonly options: TickPipelineOptions;
  private readonly now: () => number;

  constructor(
    world: World,
    snapshots: SnapshotPublisher,
    logs: LogRingBuffer,
    host: TickPipelineHost,
    options: TickPipelineOptions,
    now: () => number,
  ) {
    this.world = world;
    this.snapshots = snapshots;
    this.logs = logs;
    this.host = host;
    this.options = options;
    this.now = now;
    this.trace = new TraceRecorder({ byteBudget: options.traceByteBudget });
  }

  /** A tick is running; pause changes and some component writes wait for its end. */
  get processing(): boolean { return this._processing; }
  get lastScriptMs(): number { return this._lastScriptMs; }
  get lastPhysicsMs(): number { return this._lastPhysicsMs; }
  get recorder(): RuntimeDiagnosticRecorder | null { return this.diagnosticRecorder; }
  get lastTrace(): TracePayload | null { return this._lastTrace; }

  tick(): void {
    if (!this.host.canTick() || this._processing) return;
    this._processing = true;
    const profiling = this.diagnosticRecorder?.recording === true;
    const profileStarted = profiling ? this.now() : 0;
    const previousTick = profiling ? this.world.clock.tickIndex : 0;
    if (profiling) this.profilePublishMs = 0;
    try {
      this.host.runTick();
    } catch (error) {
      // Animation and other script phases also abort via the already-reported
      // loop sentinel; keep it inside the runtime boundary, like Actor ticks.
      if (!isInfiniteLoopError(error)) throw error;
    } finally {
      this._processing = false;
      if (profiling && this.world.clock.tickIndex > previousTick) this.diagnosticRecorder?.record(this.world.clock.tickIndex,
        this.now() - profileStarted, this._lastScriptMs, this._lastPhysicsMs, this.profilePublishMs);
      this.host.settlePauseChanges();
    }
  }

  advance(elapsedSeconds: number): void {
    if (!this.host.canAdvance()) return;
    if (this.elapsedReset) { this.elapsedReset = false; elapsedSeconds = 0; }
    this.accumulator += Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
    let steps = 0;
    // Hosts copy the snapshot once after advance(), so catch-up ticks keep their
    // overlay layout and removal pass but compose and write only the burst's
    // final frame. Any tick may pause or block the session; the flush still runs.
    this.snapshots.deferWrites(() => {
      while (!this.host.paused() && !this.host.stopped() && this.accumulator >= this.options.dt && steps < MAX_CATCH_UP_TICKS) {
        this.tick();
        this.accumulator = Math.max(0, this.accumulator - this.options.dt);
        steps += 1;
      }
    });
    if (steps === MAX_CATCH_UP_TICKS) {
      this.accumulator = 0;
    }
  }

  /** Drop accumulated time (pause changes, a settled blocking stream load). */
  resetAccumulator(): void { this.accumulator = 0; }

  /** The next `advance()` ignores its elapsed time (time spent paused). */
  discardNextElapsed(): void { this.elapsedReset = true; }

  /** Start of the tick's timed phases. */
  beginPhaseTiming(): void {
    this.phaseScriptMs = 0;
    this.phasePhysicsMs = 0;
    this.currentTimingPhase = null;
    this.phaseMark = this.now();
  }

  /** World phase boundary: time since the last mark counts toward the phase it closes. */
  markPhase(phase: TickPhase): void {
    const now = this.now();
    this.closeTimingPhase(now);
    this.currentTimingPhase = phase;
    this.phaseMark = now;
  }

  /** End of the timed phases: the tick's script and physics milliseconds become the latest. */
  closePhaseTiming(): void {
    this.closeTimingPhase(this.now());
    this.currentTimingPhase = null;
    this._lastScriptMs = this.phaseScriptMs;
    this._lastPhysicsMs = this.phasePhysicsMs;
  }

  /** Snapshot publish time counted toward the tick's profile sample. */
  profilePublish(milliseconds: number): void { this.profilePublishMs += milliseconds; }

  clearPrints(): void { this.prints = []; }

  recordPrint(print: { message: string; key: string }): void { this.prints.push(print); }

  /** After the tick's publish point: the throttled `stats` command, then the trace frame. */
  finishTick(completedFrameId: number, pending: readonly RawInputEvent[]): void {
    const statsNow = this.now();
    if (shouldEmitStatsCommand(statsNow, this.lastStatsEmitMs)) {
      this.lastStatsEmitMs = statsNow;
      this.host.emit({
        type: "stats",
        frameId: this.host.frameId(),
        tickIndex: this.world.clock.tickIndex,
        scriptMs: this._lastScriptMs,
        physicsMs: this._lastPhysicsMs,
        publishMs: this.snapshots.lastPublishMs,
        liveActors: this.host.liveActors(),
        snapshotCapacity: this.snapshots.capacity,
      });
    }
    if (this.trace.isRecording) {
      const recordedTick = this.world.clock.tickIndex;
      this.trace.recordFrame({
        tickIndex: recordedTick,
        scriptMs: this._lastScriptMs,
        physicsMs: this._lastPhysicsMs,
        logs: this.logs
          .entries()
          .filter((entry) => entry.frameId === completedFrameId)
          .map((entry) => ({
            severity: entry.severity,
            category: entry.category,
            message: entry.message,
          })),
        prints: [...this.prints],
        snapshotText: stringifyWorldSnapshot({
          ...createWorldSnapshot(this.world),
          dt: this.options.dt,
        }),
        inputEvents: pending.map((event) => {
          if (event.kind === "key") {
            return {
              type: "key",
              code: event.code,
              down: event.phase === "down",
              tick: event.tick,
            };
          }
          return { type: event.kind, tick: event.tick };
        }),
        ...this.host.traceState(),
      });
      if (!this.trace.isRecording) this.finalizeTrace();
    }
  }

  /** Console `snapshot start`: refused while a profile or frame capture records. */
  startTrace(): CommandResult | undefined {
    if (this.diagnosticRecorder?.busy) return { success: false, output: "Stop the current profile or frame capture first." };
    this.trace.start({ seed: this.options.seed, dt: this.options.dt });
    this._lastTrace = null;
    return undefined;
  }

  finalizeTrace(reason: "requested" | "session-ended" = "requested"): void {
    const payload = this.trace.stop(reason);
    if (payload) {
      this._lastTrace = payload;
      this.host.emit({
        type: "trace",
        payload: payload as unknown as Record<string, unknown>,
      });
      if (payload.retention?.stopReason === "oversized-frame") {
        this.host.reportLog(
          `Trace recording stopped: an oversized frame exceeds the ${payload.retention.byteBudget}-byte retained-data budget. ` +
          `${payload.frames.length} complete frames retained; ${payload.retention.droppedFrames} frames dropped.`,
          "warning", "Trace",
        );
      }
    }
  }

  requestDiagnosticOperation(request: DiagnosticOperationRequest): Promise<DiagnosticOperationResult> {
    this.diagnosticRecorder ??= new RuntimeDiagnosticRecorder({ generation: this.options.generation, mode: this.options.mode,
      enabled: this.options.diagnosticsEnabled, traceActive: () => this.trace.isRecording, now: this.now,
      emit: command => this.host.emit(command) });
    if (this.host.stopped()) this.diagnosticRecorder.stop();
    return this.diagnosticRecorder.request(request);
  }

  stopDiagnostics(): void { this.diagnosticRecorder?.stop(); }

  private closeTimingPhase(now: number): void {
    if (this.currentTimingPhase === null) return;
    const elapsed = now - this.phaseMark;
    if (this.currentTimingPhase === "physics") {
      this.phasePhysicsMs += elapsed;
    } else {
      this.phaseScriptMs += elapsed;
    }
  }
}
