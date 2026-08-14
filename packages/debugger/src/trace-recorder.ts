export type TraceLogEvent = {
  severity: string;
  category: string;
  message: string;
};

export type TracePrintEvent = {
  message: string;
  key: string;
};

export type TraceInputEvent = {
  type: string;
  code?: string;
  down?: boolean;
  tick: number;
};

export type TraceBtState = {
  slotId: number;
  status: string;
  btNodeId: string | null;
  lastResults: Record<string, string>;
  blackboard: Record<string, unknown>;
  stack: Array<{ nodeId: string; childIndex: number; opened: boolean }>;
  nodeMemory?: Record<string, Record<string, unknown>>;
};

export type TraceFrame = {
  tickIndex: number;
  scriptMs: number;
  physicsMs: number;
  logs: TraceLogEvent[];
  prints: TracePrintEvent[];
  snapshotText?: string;
  inputEvents?: TraceInputEvent[];
  bt?: TraceBtState[];
};

export type TracePayload = {
  seed: number;
  dt: number;
  frames: TraceFrame[];
};

export type TraceRecorderOptions = {
  /** Drop oldest frames when encoded JSON exceeds this many bytes. */
  byteBudget?: number;
};

const DEFAULT_BYTE_BUDGET = 2 * 1024 * 1024;

export class TraceRecorder {
  private readonly byteBudget: number;
  private recording = false;
  private payload: TracePayload | null = null;

  constructor(options: TraceRecorderOptions = {}) {
    this.byteBudget = options.byteBudget ?? DEFAULT_BYTE_BUDGET;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  start(meta: { seed: number; dt: number }): void {
    this.recording = true;
    this.payload = { seed: meta.seed, dt: meta.dt, frames: [] };
  }

  recordFrame(frame: TraceFrame): void {
    if (!this.recording || !this.payload) return;
    this.payload.frames.push(frame);
    this.trimToBudget();
  }

  stop(): TracePayload | null {
    if (!this.recording) return null;
    this.recording = false;
    const result = this.payload;
    this.payload = null;
    return result;
  }

  private trimToBudget(): void {
    if (!this.payload) return;
    while (
      this.payload.frames.length > 1 &&
      JSON.stringify(this.payload).length > this.byteBudget
    ) {
      this.payload.frames.shift();
    }
  }
}
