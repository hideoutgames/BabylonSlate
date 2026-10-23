import { DEFAULT_TRACE_BYTE_BUDGET } from "@haptic/core";

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
  /** Every Play Sound voice the slot's actor owns (stopped on abort or slot release); omitted when none. */
  playSoundVoiceIds?: string[];
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
  /** The playSound clip and pitch draws (`clipRoll`, `pitchRoll`), so a restore replays the same clip at the same pitch. */
  clipRoll?: number;
  pitchRoll?: number;
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
  /**
   * Time dilation this tick's step used (step = undilated `dt` × dilation).
   * A change made during a tick appears on the next frame.
   */
  timeDilation: number;
  scriptMs: number;
  physicsMs: number;
  /** The most recent snapshot publish when the tick ended; absent from traces recorded before it was kept. */
  publishMs?: number;
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
  retention: TraceRetention;
};

export type TraceRecorderOptions = {
  /** Drop oldest complete frames at this UTF-8 JSON budget. An oversized frame stops recording. */
  byteBudget?: number;
};

const encoder = new TextEncoder();
/** Evicted frames stay in the arrays until this many are dead and they outnumber the live ones. */
const COMPACT_EVICTED_FRAMES = 1024;
/** The ASCII `"snapshotText":` that precedes the value inside a frame's JSON. */
const SNAPSHOT_MEMBER_NAME_BYTES = '"snapshotText":'.length;

/**
 * The UTF-8 size of `JSON.stringify(text)`, counted in one pass without building
 * the escaped string or its bytes: quotes and backslashes take two bytes, control
 * characters two or six, a lone surrogate is escaped to six, and every other
 * character takes its UTF-8 length.
 */
function jsonStringBytes(text: string): number {
  let bytes = 2;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      if (code >= 0x20 && code !== 0x22 && code !== 0x5c) bytes += 1;
      else bytes += code === 0x22 || code === 0x5c || (code >= 8 && code <= 10) || code === 12 || code === 13 ? 2 : 6;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code < 0xd800 || code > 0xdfff) {
      bytes += 3;
    } else if (code < 0xdc00 && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 6;
    }
  }
  return bytes;
}

/**
 * The UTF-8 size of `JSON.stringify(frame)`. A snapshot is the one large member
 * and is itself JSON text, so it is counted in place instead of being escaped and
 * encoded a second time.
 */
function frameJsonBytes(frame: TraceFrame): number {
  const { snapshotText, ...rest } = frame;
  if (typeof snapshotText !== "string") return encoder.encode(JSON.stringify(frame)).byteLength;
  const members = JSON.stringify(rest);
  // The member joins the others before the closing brace, after a comma unless it is the only one.
  return encoder.encode(members).byteLength + (members === "{}" ? 0 : 1) +
    SNAPSHOT_MEMBER_NAME_BYTES + jsonStringBytes(snapshotText);
}

export class TraceRecorder {
  private readonly byteBudget: number;
  private recording = false;
  private payload: TracePayload | null = null;
  private frameBytes: number[] = [];
  /** Frames and sizes before this index were evicted; `stop` drops them. */
  private head = 0;
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

  /** Returns false and keeps the current recording when one is already running. */
  start(meta: { seed: number; dt: number }): boolean {
    if (this.recording) return false;
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
    this.head = 0;
    this.headerBytes = headerBytes;
    this.encodedBytes = headerBytes;
    return true;
  }

  recordFrame(frame: TraceFrame): void {
    if (!this.recording || !this.payload) return;
    const bytes = frameJsonBytes(frame);
    if (bytes > this.byteBudget - this.headerBytes) {
      this.recording = false;
      this.payload.retention.droppedFrames += 1;
      this.payload.retention.complete = false;
      this.payload.retention.stopReason = "oversized-frame";
      return;
    }
    // The empty payload already accounts for the header and array brackets.
    this.encodedBytes += bytes + (this.payload.frames.length > this.head ? 1 : 0);
    this.payload.frames.push(frame);
    this.frameBytes.push(bytes);
    this.trimToBudget();
  }

  stop(reason: Exclude<TraceStopReason, "oversized-frame"> = "requested"): TracePayload | null {
    if (!this.payload) return null;
    if (this.recording) this.payload.retention.stopReason = reason;
    this.recording = false;
    const result = this.payload;
    result.frames.splice(0, this.head);
    this.payload = null;
    this.frameBytes = [];
    this.head = 0;
    this.encodedBytes = 0;
    this.headerBytes = 0;
    return result;
  }

  private trimToBudget(): void {
    if (!this.payload) return;
    const frames = this.payload.frames as Array<TraceFrame | undefined>;
    // Evicting by index keeps each recorded frame O(1); the slot is cleared so the frame can be collected.
    while (frames.length - this.head > 1 && this.encodedBytes > this.byteBudget) {
      frames[this.head] = undefined;
      this.encodedBytes -= this.frameBytes[this.head]! + 1;
      this.head += 1;
      this.payload.retention.droppedFrames += 1;
      this.payload.retention.complete = false;
    }
    if (this.head >= COMPACT_EVICTED_FRAMES && this.head * 2 >= frames.length) {
      frames.splice(0, this.head);
      this.frameBytes.splice(0, this.head);
      this.head = 0;
    }
  }
}
