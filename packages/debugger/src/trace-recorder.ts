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
  /** A Play Animation task owns the slot's animation state; omitted when false. */
  playAnimationOwned?: boolean;
  /** The Play Sound voice the slot's actor owns (stopped on abort or slot release); omitted when none. */
  playSoundVoiceId?: string;
};

/** A voice the runtime started and has neither stopped nor seen end by the frame. */
export type TraceVoice = {
  /** AudioComponent guid, `bt:<actor>:<node>` for Play Sound tasks, or `script:<n>` for script Play Sound. */
  voiceId: string;
  assetGuid: string;
  /** Play-call volume, including later `setVoiceGain` changes. */
  volume: number;
  /** Omitted when the Audio asset's own Loop flag decides. */
  loop?: boolean;
  /** Spatial emitter; omitted for non-spatial voices. */
  emitterActorGuid?: string;
  /** Undilated fixed-step seconds since the voice started. */
  elapsedSeconds: number;
};

export type TraceAudioState = {
  /** Live voices in start order. */
  voices: TraceVoice[];
  /** Sequence number of the next script Play Sound voice id. */
  nextScriptVoice: number;
};

/** The Sprite Animation clip an actor shows (Animation Graph or Play Animation). */
export type TraceSpriteClip = {
  actorGuid: string;
  stateId: string;
  assetGuid: string;
  clipName: string;
  normalisedTime: number;
};

/** One AnimationGraphComponent's evaluation, so its graph continues mid-state. */
export type TraceAnimGraphState = {
  componentGuid: string;
  /** Present with `state` when the graph was initialized and evaluated for this component. */
  graphGuid?: string;
  state?: Record<string, unknown>;
  /** A script Jump To State not applied yet. */
  pendingJumpStateId?: string;
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
  audio?: TraceAudioState;
  sprites?: TraceSpriteClip[];
  animGraphs?: TraceAnimGraphState[];
};

export type TraceStopReason = "requested" | "session-ended" | "oversized-frame";

export type TraceRetention = {
  /** UTF-8 JSON payload budget, including metadata; not a heap limit. */
  byteBudget: number;
  /** Evicted complete frames plus an oversized rejected frame, if any. */
  droppedFrames: number;
  /** False when any frame was omitted from the recording. */
  complete: boolean;
  stopReason: TraceStopReason;
};

export type TracePayload = {
  seed: number;
  dt: number;
  frames: TraceFrame[];
  /** Optional so existing .babtrace documents remain readable. */
  retention?: TraceRetention;
};

export type TraceRecorderOptions = {
  /** Drop oldest complete frames at this UTF-8 JSON budget. An oversized frame stops recording. */
  byteBudget?: number;
};

const encoder = new TextEncoder();

export class TraceRecorder {
  private readonly byteBudget: number;
  private recording = false;
  private payload: (TracePayload & { retention: TraceRetention }) | null = null;
  private frameBytes: number[] = [];
  private encodedBytes = 0;
  private headerBytes = 0;

  constructor(options: TraceRecorderOptions = {}) {
    this.byteBudget = options.byteBudget ?? DEFAULT_TRACE_BYTE_BUDGET;
    if (!Number.isSafeInteger(this.byteBudget) || this.byteBudget <= 0)
      throw new RangeError("Trace data budget must be a positive safe integer.");
  }

  get isRecording(): boolean {
    return this.recording;
  }

  start(meta: { seed: number; dt: number }): void {
    const retention: TraceRetention = {
      byteBudget: this.byteBudget,
      droppedFrames: 0,
      complete: true,
      stopReason: "requested",
    };
    // Reserve the longest terminal metadata once. Stopping on an oversized
    // frame must never evict a previously accepted frame just to fit its reason.
    const headerBytes = encoder.encode(JSON.stringify({
      ...meta, frames: [], retention: {
        ...retention, droppedFrames: Number.MAX_SAFE_INTEGER,
        complete: false, stopReason: "oversized-frame",
      },
    })).byteLength;
    if (headerBytes > this.byteBudget)
      throw new RangeError("Trace data budget cannot hold recording metadata.");
    this.recording = true;
    this.payload = { seed: meta.seed, dt: meta.dt, frames: [], retention };
    this.frameBytes = [];
    this.headerBytes = headerBytes;
    this.encodedBytes = headerBytes;
  }

  recordFrame(frame: TraceFrame): void {
    if (!this.recording || !this.payload) return;
    const bytes = encoder.encode(JSON.stringify(frame)).byteLength;
    if (bytes > this.byteBudget - this.headerBytes) {
      this.recording = false;
      this.payload.retention.droppedFrames += 1;
      this.payload.retention.complete = false;
      this.payload.retention.stopReason = "oversized-frame";
      return;
    }
    // The empty payload already accounts for the header and array brackets.
    this.encodedBytes += bytes + (this.payload.frames.length > 0 ? 1 : 0);
    this.payload.frames.push(frame);
    this.frameBytes.push(bytes);
    this.trimToBudget();
  }

  stop(reason: Exclude<TraceStopReason, "oversized-frame"> = "requested"): TracePayload | null {
    if (!this.payload) return null;
    if (this.recording) this.payload.retention.stopReason = reason;
    this.recording = false;
    const result = this.payload;
    this.payload = null;
    this.frameBytes = [];
    this.encodedBytes = 0;
    this.headerBytes = 0;
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
      this.payload.retention.droppedFrames += 1;
      this.payload.retention.complete = false;
    }
  }
}
