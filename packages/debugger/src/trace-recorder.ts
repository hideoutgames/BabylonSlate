import { DEFAULT_TRACE_BYTE_BUDGET } from "@babylonslate/core";

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
  /** Drop oldest frames when UTF-8 JSON exceeds this many bytes; always keep the newest frame. */
  byteBudget?: number;
};

const encoder = new TextEncoder();

export class TraceRecorder {
  private readonly byteBudget: number;
  private recording = false;
  private payload: TracePayload | null = null;
  private frameBytes: number[] = [];
  private encodedBytes = 0;

  constructor(options: TraceRecorderOptions = {}) {
    this.byteBudget = options.byteBudget ?? DEFAULT_TRACE_BYTE_BUDGET;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  start(meta: { seed: number; dt: number }): void {
    this.recording = true;
    this.payload = { seed: meta.seed, dt: meta.dt, frames: [] };
    this.frameBytes = [];
    this.encodedBytes = encoder.encode(JSON.stringify(this.payload)).byteLength;
  }

  recordFrame(frame: TraceFrame): void {
    if (!this.recording || !this.payload) return;
    const bytes = encoder.encode(JSON.stringify(frame)).byteLength;
    // The empty payload already accounts for the header and array brackets.
    this.encodedBytes += bytes + (this.payload.frames.length > 0 ? 1 : 0);
    this.payload.frames.push(frame);
    this.frameBytes.push(bytes);
    this.trimToBudget();
  }

  stop(): TracePayload | null {
    if (!this.recording) return null;
    this.recording = false;
    const result = this.payload;
    this.payload = null;
    this.frameBytes = [];
    this.encodedBytes = 0;
    return result;
  }

  private trimToBudget(): void {
    if (!this.payload) return;
    while (
      this.payload.frames.length > 1 &&
      this.encodedBytes > this.byteBudget
    ) {
      this.payload.frames.shift();
      this.encodedBytes -= this.frameBytes.shift()! + 1;
    }
  }
}
