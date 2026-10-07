import type { CommandMessage, DiagnosticOperationRequest, DiagnosticOperationResult, GameSessionMode } from "@babylonslate/bridge";
import { PERFORMANCE_TICK_COLUMNS } from "@babylonslate/debugger";

const ROWS = 256;
const WIDTH = PERFORMANCE_TICK_COLUMNS.length;
type Recording = {
  id: string; kind: "profile" | "frame"; started: number; deadline: number;
  budget: number; sentBytes: number; sequence: number; count: number; dropped: number;
  buffer: Float64Array | null;
  timer: ReturnType<typeof setTimeout>;
  delivery: ReturnType<typeof setInterval> | null;
};

/** Allocates timing storage/timers only while an explicit exclusive lease is held. */
export class RuntimeDiagnosticRecorder {
  private active: Recording | null = null;
  private stopped = false;
  private lastRequestId = 0;
  private pending = 0;
  constructor(private readonly host: {
    generation: number; mode: GameSessionMode; enabled: boolean;
    traceActive(): boolean; now(): number; emit(command: CommandMessage): void;
  }) {}
  get recording(): boolean { return this.active?.kind === "profile"; }
  get busy(): boolean { return this.active !== null; }
  request(request: DiagnosticOperationRequest): Promise<DiagnosticOperationResult> {
    const operation = request?.operation;
    const reply = (reason?: string): DiagnosticOperationResult => ({ sessionGeneration: request?.sessionGeneration, requestId: request?.requestId,
      recordingId: operation?.recordingId ?? "", success: !reason, ...(reason ? { reason } : {}) });
    const invalid = request?.sessionGeneration !== this.host.generation ? "Stale session generation." :
      !Number.isSafeInteger(request?.requestId) || request.requestId <= this.lastRequestId ? "Invalid or superseded diagnostic request ID." :
      this.stopped ? "The game session has stopped." : this.host.mode === "simulate" ? "Use Play or Preview Build to record diagnostics." :
      !this.host.enabled ? "Editor diagnostics are unavailable in this build." :
      !operation || !["profile", "frame"].includes(operation.kind) || !["start", "stop"].includes(operation.action) ||
      typeof operation.recordingId !== "string" || operation.recordingId.length < 1 || operation.recordingId.length > 128 ? "Invalid diagnostic operation." :
      this.pending >= 32 ? "Diagnostic request queue is full." : null;
    if (invalid) return Promise.resolve(reply(invalid));
    this.lastRequestId = request.requestId; this.pending++;
    const accepted = { ...operation };
    return new Promise(resolve => queueMicrotask(() => {
      this.pending--;
      if (this.stopped) { resolve(reply("The game session has stopped.")); return; }
      if (accepted.action === "stop") {
        if (this.active && (this.active.id !== accepted.recordingId || this.active.kind !== accepted.kind)) resolve(reply("Another diagnostic operation owns this session."));
        else { this.finish("requested"); resolve(reply()); }
        return;
      }
      if (this.active || this.host.traceActive()) { resolve(reply("Stop the current trace, profile or frame capture first.")); return; }
      const duration = accepted.durationMs ?? 10_000;
      const budget = accepted.byteBudget ?? 16 * 1024 * 1024;
      if (!Number.isFinite(duration) || duration < 1_000 || duration > 60_000 || !Number.isSafeInteger(budget) || budget < WIDTH * 8 || budget > 64 * 1024 * 1024) {
        resolve(reply("Invalid diagnostic duration or numeric data budget.")); return;
      }
      const now = this.host.now();
      const active: Recording = { id: accepted.recordingId, kind: accepted.kind, started: now, deadline: now + duration,
        budget, sentBytes: 0, sequence: 0, count: 0, dropped: 0,
        buffer: accepted.kind === "profile" ? new Float64Array(ROWS * WIDTH) : null,
        timer: setTimeout(() => this.finish("duration"), duration), delivery: null };
      this.active = active;
      if (accepted.kind === "profile") active.delivery = setInterval(() => this.flush(), 200);
      resolve(reply());
    }));
  }
  record(tickId: number, totalMs: number, scriptMs: number, physicsMs: number, publishMs: number): void {
    const active = this.active;
    if (!active?.buffer) return;
    if (this.host.now() >= active.deadline) { this.finish("duration"); return; }
    if (active.count >= ROWS) { active.dropped++; return; }
    if (active.sentBytes + (active.count + 1) * WIDTH * 8 > active.budget) {
      active.dropped++;
      // Deferred until advance() finishes attributing its final snapshot write.
      queueMicrotask(() => { if (this.active === active) this.finish("budget"); }); return;
    }
    const offset = active.count++ * WIDTH;
    active.buffer[offset] = tickId; active.buffer[offset + 1] = this.host.now() - active.started;
    active.buffer[offset + 2] = scriptMs; active.buffer[offset + 3] = physicsMs; active.buffer[offset + 4] = publishMs;
    active.buffer[offset + 5] = Math.max(0, totalMs - scriptMs - physicsMs - publishMs);
  }
  addPublishCost(tickId: number, milliseconds: number): void {
    const active = this.active;
    if (!active?.buffer || active.count === 0) return;
    const offset = (active.count - 1) * WIDTH;
    if (active.buffer[offset] === tickId) active.buffer[offset + 4] = (active.buffer[offset + 4] ?? 0) + milliseconds;
  }
  private flush(): void {
    const active = this.active;
    if (!active?.buffer || (!active.count && !active.dropped)) return;
    const rows = active.buffer.slice(0, active.count * WIDTH);
    active.sentBytes += rows.byteLength; active.count = 0;
    this.host.emit({ type: "performanceTicks", sessionGeneration: this.host.generation, recordingId: active.id,
      sequence: active.sequence++, rows, droppedRecords: active.dropped });
    active.dropped = 0;
  }
  private finish(reason: "requested" | "duration" | "budget" | "session-ended"): void {
    const active = this.active;
    if (!active) return;
    clearTimeout(active.timer); if (active.delivery !== null) clearInterval(active.delivery);
    this.flush(); this.active = null;
    this.host.emit({ type: "diagnosticOperationStopped", sessionGeneration: this.host.generation,
      recordingId: active.id, kind: active.kind, reason });
  }
  stop(): void { this.stopped = true; this.finish("session-ended"); }
}
