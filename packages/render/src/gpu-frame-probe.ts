import type { DrawPass } from "./draw-passes";

/**
 * The Feature Test Check's GPU probes (`gpuprobe`), which explain a frame cost that `gpubusy` reads censored: with a
 * frame already in flight, GPU busy equals the frame period, which lands on whole display intervals.
 *
 * Passive, while `gpuprobe on` measures (every frame, nothing changed):
 * - the GL call signature (`GlSignatureRecorder`, installed on the context by `installGlSignature` and removed by
 *   `gpuprobe off`): per Engine frame its passes, clears, blits, invalidates, draws, texels cleared and covered, and a
 *   structure hash over the ordered pass list that leaves draw counts out;
 * - shadow map counters (`ShadowFrameWindow`): maps redrawn and cached, continuous ones, texels redrawn, the atlas
 *   edge and its generation;
 * - the raw `requestAnimationFrame` rate (`RafCadence`), rendered or not.
 *
 * Perturbing, once per `gpuprobe serial` (`SerialFrameProbe`): rendering stops until every submitted frame has
 * finished, then a few frames render one at a time with a fence after each stage, then a fixed synthetic load runs.
 */

/** Median of `values`; null for none. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** FNV-1a over a string, as 8 hex digits. */
export function structureHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const FRAMEBUFFER = 0x8d40;
const DRAW_FRAMEBUFFER = 0x8ca9;
const SCISSOR_TEST = 0x0c11;
const COLOR_BUFFER_BIT = 0x4000;
const DEPTH_BUFFER_BIT = 0x0100;
const STENCIL_BUFFER_BIT = 0x0400;
const COLOR = 0x1800;
const DEPTH = 0x1801;
const STENCIL = 0x1802;
const DEPTH_STENCIL = 0x84f9;

/** Frames kept per window; a Profile window is 5 s. */
const MAX_WINDOW_FRAMES = 2048;
/** Passes recorded per frame; more are counted into the last. */
const MAX_FRAME_PASSES = 256;
/** Distinct structures kept with their readable pass list, and how long a list may be. */
const MAX_STRUCTURES = 6;
const MAX_LISTED_PASSES = 64;
const MAX_PASS_TEXT = 160;

type Rect = readonly [number, number, number, number];
const rectText = (rect: Rect) => `${rect[0]},${rect[1]},${rect[2]}x${rect[3]}`;

/** One pass of a frame: a run of work on one draw framebuffer. */
interface PassRecord {
  target: object | null;
  /** Its framebuffer's id within the frame: D for the default one, F1, F2... by first appearance. */
  id: string;
  /** Viewports its work ran in, each once, in order. */
  viewports: string[];
  /** Clears (`d@0,0,2048x2048`) and blits (`b1280x720c`), in order. */
  ops: string[];
  draws: number;
  invalidates: number;
}

/** One Engine frame's signature (`GlSignatureRecorder.endFrame`). */
export interface GlFrameRecord {
  hash: string;
  passes: number;
  clears: number;
  blits: number;
  invalidates: number;
  draws: number;
  texelsCleared: number;
  texelsCovered: number;
}

/** A window's signature (`GlSignatureRecorder.stats`): medians per frame and its pass structures. */
export interface GlSignatureStats {
  frames: number;
  /** The structure most frames had, its share of the frames, and how many distinct structures there were. */
  modal: string;
  modalShare: number;
  distinct: number;
  passes: number;
  clears: number;
  blits: number;
  invalidates: number;
  draws: number;
  texelsCleared: number;
  texelsCovered: number;
  /** Up to `MAX_STRUCTURES` structures, most frequent first, each with the readable pass list of its first frame. */
  structures: { hash: string; frames: number; passes: string[] }[];
}

/**
 * Records the GL calls of each Engine frame as passes (`installGlSignature` feeds it) and summarises a window of frames.
 * A pass starts at the first clear, draw, blit or invalidate on a draw framebuffer other than the current pass's. The
 * structure hash covers the ordered passes' framebuffer ids, viewports, clear masks and areas and blit sizes, not draw
 * counts, which moving actors change.
 */
export class GlSignatureRecorder {
  private drawTarget: object | null = null;
  private viewportRect: Rect = [0, 0, 0, 0];
  private scissorRect: Rect = [0, 0, 0, 0];
  private scissorOn = false;
  private inFrame = false;
  private readonly passes: PassRecord[] = [];
  private ids = new Map<object | null, string>();
  private clears = 0;
  private blits = 0;
  private invalidates = 0;
  private draws = 0;
  private texelsCleared = 0;
  private texelsCovered = 0;
  private readonly frames: GlFrameRecord[] = [];
  private readonly listed = new Map<string, string[]>();
  private readonly counts = new Map<string, number>();
  /** The last frame's hash, while one has ended. */
  lastHash: string | null = null;
  /**
   * Called as a pass is about to start: before the frame's first clear, draw, blit or invalidate, and before the first
   * on another draw framebuffer than the last pass's, with every call of the passes before it already made. A fence
   * submitted from it splits none.
   */
  onPassStart: (() => void) | null = null;
  /** Fences submitted inside a pass that then went on (`fence`): each split one GPU render pass in two. */
  fenceSplits = 0;
  private fenced = false;

  /** The context's state as the recorder is installed. */
  seed(state: { drawTarget: object | null; viewport: Rect; scissor: Rect; scissorTest: boolean }): void {
    this.drawTarget = state.drawTarget;
    this.viewportRect = state.viewport;
    this.scissorRect = state.scissor;
    this.scissorOn = state.scissorTest;
  }

  /** Starts a window, discarding the previous one. */
  start(): void {
    this.frames.length = 0;
    this.listed.clear();
    this.counts.clear();
    this.lastHash = null;
  }

  /** `gl.bindFramebuffer`: only the draw binding moves passes; a read binding (a blit's or a read-back's source) does not. */
  bind(target: number, framebuffer: object | null): void {
    if (target === FRAMEBUFFER || target === DRAW_FRAMEBUFFER) this.drawTarget = framebuffer;
  }

  viewport(x: number, y: number, width: number, height: number): void { this.viewportRect = [x, y, width, height]; }
  scissor(x: number, y: number, width: number, height: number): void { this.scissorRect = [x, y, width, height]; }
  setCapability(capability: number, enabled: boolean): void { if (capability === SCISSOR_TEST) this.scissorOn = enabled; }

  /** `gl.clear(mask)`. */
  clear(mask: number): void {
    const bits = `${mask & COLOR_BUFFER_BIT ? "c" : ""}${mask & DEPTH_BUFFER_BIT ? "d" : ""}${mask & STENCIL_BUFFER_BIT ? "s" : ""}`;
    this.clearBits(bits || "-");
  }

  /** `gl.clearBuffer*(buffer, drawBuffer)`. */
  clearBuffer(buffer: number, drawBuffer: number): void {
    const bits = buffer === COLOR ? `c${drawBuffer}` : buffer === DEPTH ? "d" : buffer === STENCIL ? "s" : buffer === DEPTH_STENCIL ? "ds" : "?";
    this.clearBits(bits);
  }

  draw(): void {
    if (!this.inFrame) return;
    const pass = this.pass();
    this.noteViewport(pass);
    pass.draws += 1;
    this.draws += 1;
  }

  blit(width: number, height: number, mask: number): void {
    if (!this.inFrame) return;
    const pass = this.pass();
    const bits = `${mask & COLOR_BUFFER_BIT ? "c" : ""}${mask & DEPTH_BUFFER_BIT ? "d" : ""}${mask & STENCIL_BUFFER_BIT ? "s" : ""}`;
    pass.ops.push(`b${Math.abs(width)}x${Math.abs(height)}${bits}`);
    this.blits += 1;
  }

  invalidate(): void {
    if (!this.inFrame) return;
    this.pass().invalidates += 1;
    this.invalidates += 1;
  }

  /**
   * A fence and flush were submitted now. One between two passes costs nothing; one inside a pass ends the GPU's
   * render pass (ANGLE ends its Metal encoder at a flush), so the work after it starts a second one that loads what
   * the first stored. Counted once the next work lands on the same pass.
   */
  fence(): void {
    if (this.inFrame && this.passes.length) this.fenced = true;
  }

  beginFrame(): void {
    this.inFrame = true;
    this.fenced = false;
    this.passes.length = 0;
    this.ids = new Map();
    this.clears = this.blits = this.invalidates = this.draws = this.texelsCleared = this.texelsCovered = 0;
  }

  /** Ends the frame; a frame with no work is not recorded (null). */
  endFrame(): GlFrameRecord | null {
    if (!this.inFrame) return null;
    this.inFrame = false;
    if (!this.passes.length) return null;
    const structure = this.passes.map(passStructure);
    const hash = structureHash(structure.join("\n"));
    const record: GlFrameRecord = {
      hash, passes: this.passes.length, clears: this.clears, blits: this.blits, invalidates: this.invalidates,
      draws: this.draws, texelsCleared: this.texelsCleared, texelsCovered: this.texelsCovered,
    };
    this.lastHash = hash;
    if (this.frames.length < MAX_WINDOW_FRAMES) this.frames.push(record);
    this.counts.set(hash, (this.counts.get(hash) ?? 0) + 1);
    if (!this.listed.has(hash) && this.listed.size < MAX_STRUCTURES * 4) {
      const lines = this.passes.slice(0, MAX_LISTED_PASSES).map((pass, index) => passText(pass, structure[index]!));
      if (this.passes.length > MAX_LISTED_PASSES) lines.push(`... ${this.passes.length - MAX_LISTED_PASSES} more passes`);
      this.listed.set(hash, lines);
    }
    return record;
  }

  stats(): GlSignatureStats | null {
    const frames = this.frames;
    if (!frames.length) return null;
    const ranked = [...this.counts].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((sum, [, count]) => sum + count, 0);
    const pick = (field: Exclude<keyof GlFrameRecord, "hash">) => median(frames.map((frame) => frame[field])) ?? 0;
    return {
      frames: total, modal: ranked[0]![0], modalShare: ranked[0]![1] / total, distinct: ranked.length,
      passes: pick("passes"), clears: pick("clears"), blits: pick("blits"), invalidates: pick("invalidates"), draws: pick("draws"),
      texelsCleared: pick("texelsCleared"), texelsCovered: pick("texelsCovered"),
      structures: ranked.slice(0, MAX_STRUCTURES).map(([hash, count]) => ({ hash, frames: count, passes: this.listed.get(hash) ?? [] })),
    };
  }

  private clearBits(bits: string): void {
    if (!this.inFrame) return;
    const pass = this.pass();
    this.noteViewport(pass);
    const rect = this.scissorOn ? this.scissorRect : this.viewportRect;
    pass.ops.push(`${bits}@${rectText(rect)}`);
    this.clears += 1;
    this.texelsCleared += Math.max(0, rect[2]) * Math.max(0, rect[3]);
  }

  /** The pass work on the current draw framebuffer belongs to: the current one, or a new one. */
  private pass(): PassRecord {
    const current = this.passes[this.passes.length - 1];
    const fenced = this.fenced;
    this.fenced = false;
    if (current && (current.target === this.drawTarget || this.passes.length >= MAX_FRAME_PASSES)) {
      if (fenced && current.target === this.drawTarget) this.fenceSplits += 1;
      return current;
    }
    this.onPassStart?.();
    let id = this.ids.get(this.drawTarget);
    if (!id) {
      id = this.drawTarget === null ? "D" : `F${this.ids.size + (this.ids.has(null) ? 0 : 1)}`;
      this.ids.set(this.drawTarget, id);
    }
    const pass: PassRecord = { target: this.drawTarget, id, viewports: [], ops: [], draws: 0, invalidates: 0 };
    this.passes.push(pass);
    return pass;
  }

  private noteViewport(pass: PassRecord): void {
    const text = rectText(this.viewportRect);
    if (pass.viewports.includes(text)) return;
    pass.viewports.push(text);
    this.texelsCovered += Math.max(0, this.viewportRect[2]) * Math.max(0, this.viewportRect[3]);
  }
}

/** What a pass contributes to the structure hash: no draw or invalidate counts. */
function passStructure(pass: PassRecord): string {
  return `${pass.id} v${pass.viewports.join(" ")}${pass.ops.length ? ` ${pass.ops.join(" ")}` : ""}`;
}

/** A pass as the report lists it: its structure, then its draws and invalidates. */
function passText(pass: PassRecord, structure: string): string {
  const text = `${structure}${pass.draws ? ` x${pass.draws}` : ""}${pass.invalidates ? ` inv${pass.invalidates}` : ""}`;
  return text.length > MAX_PASS_TEXT ? `${text.slice(0, MAX_PASS_TEXT - 3)}...` : text;
}

type Callable = (...args: never[]) => unknown;

/**
 * Wraps `gl`'s framebuffer, clear, draw, blit, invalidate, viewport and scissor calls to feed `recorder`, as own
 * properties over the prototype's; the returned function restores them. The recorder is seeded with the context's
 * state now.
 */
export function installGlSignature(gl: WebGL2RenderingContext, recorder: GlSignatureRecorder): () => void {
  const own = gl as unknown as Record<string, unknown>;
  const restores: (() => void)[] = [];
  const wrap = <F extends Callable>(name: string, before: (...args: Parameters<F>) => void) => {
    const original = own[name] as F | undefined;
    if (typeof original !== "function") return;
    const previous = Object.getOwnPropertyDescriptor(gl, name);
    own[name] = function wrapped(this: unknown, ...args: Parameters<F>) {
      before(...args);
      return (original as unknown as (...rest: unknown[]) => unknown).apply(gl, args);
    };
    restores.push(() => {
      if (previous) Object.defineProperty(gl, name, previous);
      else delete own[name];
    });
  };
  const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array | null;
  const scissor = gl.getParameter(gl.SCISSOR_BOX) as Int32Array | null;
  recorder.seed({
    drawTarget: (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null) ?? null,
    viewport: viewport ? [viewport[0]!, viewport[1]!, viewport[2]!, viewport[3]!] : [0, 0, 0, 0],
    scissor: scissor ? [scissor[0]!, scissor[1]!, scissor[2]!, scissor[3]!] : [0, 0, 0, 0],
    scissorTest: gl.isEnabled(gl.SCISSOR_TEST),
  });
  wrap("bindFramebuffer", (target: number, framebuffer: WebGLFramebuffer | null) => recorder.bind(target, framebuffer));
  wrap("viewport", (x: number, y: number, width: number, height: number) => recorder.viewport(x, y, width, height));
  wrap("scissor", (x: number, y: number, width: number, height: number) => recorder.scissor(x, y, width, height));
  wrap("enable", (capability: number) => recorder.setCapability(capability, true));
  wrap("disable", (capability: number) => recorder.setCapability(capability, false));
  wrap("clear", (mask: number) => recorder.clear(mask));
  for (const name of ["clearBufferfv", "clearBufferiv", "clearBufferuiv", "clearBufferfi"])
    wrap(name, (buffer: number, drawBuffer: number) => recorder.clearBuffer(buffer, drawBuffer));
  for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"])
    wrap(name, () => recorder.draw());
  wrap("blitFramebuffer", (_x0: number, _y0: number, _x1: number, _y1: number, x0: number, y0: number, x1: number, y1: number, mask: number) =>
    recorder.blit(x1 - x0, y1 - y0, mask));
  for (const name of ["invalidateFramebuffer", "invalidateSubFramebuffer"]) wrap(name, () => recorder.invalidate());
  return () => { for (const restore of restores.splice(0).reverse()) restore(); };
}

/** One Engine frame's shadow map work (`ShadowFrameWindow.add`). */
export interface ShadowFrameRecord {
  /** Maps the scene and its views hold (standby ones left out), and those that redraw every frame. */
  maps: number;
  continuous: number;
  /** Maps, tiles and texels drawn into the Scene's atlas this frame. */
  redrawn: number;
  tiles: number;
  texels: number;
  atlasEdge: number;
  atlasGeneration: number;
}

/** A window's shadow counters: medians per frame, maps cached = held minus redrawn. */
export interface ShadowFrameStats {
  frames: number;
  maps: number;
  redrawn: number;
  cached: number;
  continuous: number;
  tiles: number;
  texels: number;
  atlasEdge: number;
  /** The atlas generation (how many atlases the Scene has made) at the window's first and last frame. */
  generationFirst: number;
  generationLast: number;
}

export class ShadowFrameWindow {
  private readonly frames: ShadowFrameRecord[] = [];
  start(): void { this.frames.length = 0; }
  add(record: ShadowFrameRecord): void { if (this.frames.length < MAX_WINDOW_FRAMES) this.frames.push(record); }
  stats(): ShadowFrameStats | null {
    const frames = this.frames;
    if (!frames.length) return null;
    const pick = (read: (frame: ShadowFrameRecord) => number) => median(frames.map(read)) ?? 0;
    return {
      frames: frames.length, maps: pick((frame) => frame.maps), redrawn: pick((frame) => frame.redrawn),
      cached: pick((frame) => Math.max(0, frame.maps - frame.redrawn)), continuous: pick((frame) => frame.continuous),
      tiles: pick((frame) => frame.tiles), texels: pick((frame) => frame.texels), atlasEdge: pick((frame) => frame.atlasEdge),
      generationFirst: frames[0]!.atlasGeneration, generationLast: frames[frames.length - 1]!.atlasGeneration,
    };
  }
}

/** `requestAnimationFrame` callbacks per second while measuring, whether or not a frame rendered in them. */
export class RafCadence {
  private handle = 0;
  private count = 0;
  private started = 0;
  private last = 0;
  private running = false;
  private readonly request: (callback: () => void) => number;
  private readonly cancel: (handle: number) => void;
  private readonly now: () => number;

  constructor(
    request: (callback: () => void) => number = (callback) => requestAnimationFrame(callback),
    cancel: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
    now: () => number = () => performance.now(),
  ) {
    this.request = request;
    this.cancel = cancel;
    this.now = now;
  }

  /** Starts (restarting) counting. */
  start(): void {
    this.stop();
    this.running = true;
    this.count = 0;
    this.started = this.last = this.now();
    this.handle = this.request(this.tick);
  }

  stop(): void {
    if (this.running) this.cancel(this.handle);
    this.running = false;
  }

  stats(): { callbacks: number; ms: number; perSecond: number } | null {
    const ms = this.last - this.started;
    return this.count > 1 && ms > 0 ? { callbacks: this.count, ms, perSecond: ((this.count - 1) * 1000) / ms } : null;
  }

  private readonly tick = () => {
    if (!this.running) return;
    this.count += 1;
    this.last = this.now();
    this.handle = this.request(this.tick);
  };
}

/** The stages a serialised frame is fenced after (`frameStageOf`); `other` is work before the first. */
export const FRAME_STAGES = ["other", "shadows", "captures", "main", "effects", "tail"] as const;
export type FrameStage = (typeof FRAME_STAGES)[number];

/**
 * The stage a draw pass's work belongs to: shadow maps; captures, mirrors and probes (their own shadow maps and post
 * included); the main colour pass (objects, water, outlines); geometry effects and post; the device-resolution tail
 * (Scene Layers, and from the FSR upscale on, `"tail"`). Null: work that does not move the stage (cull, readiness,
 * particles, observers, other).
 */
export function frameStageOf(pass: DrawPass | "tail"): FrameStage | null {
  switch (pass) {
    case "shadows": return "shadows";
    case "captures": case "mirrors": case "probes": return "captures";
    case "objects": case "water": case "outlines": return "main";
    case "geometry": case "post": return "effects";
    case "layers": case "tail": return "tail";
    default: return null;
  }
}

/** A submitted fence: whether the GPU has finished what was submitted before it (null: cannot tell, a lost context). */
export interface ProbeFence {
  done(): boolean | null;
  dispose(): void;
}

/** What the serialised probe runs on (`SerialFrameProbe`). */
export interface SerialProbeHost {
  /** Submits a fence and flushes; null without fences. */
  fence(): ProbeFence | null;
  now(): number;
  /** Runs `callback` in a later task, soon (a MessageChannel message: no timer clamp). */
  schedule(callback: () => void): void;
  /** Whether the frame loop's own frame markers have all finished (`FrameBackpressure`): nothing else is queued. */
  drained(): boolean;
  /** The synthetic load: whether its program is ready, and one fenced draw of it; null where there is none. */
  synthetic: { ready(): boolean; draw(): void } | null;
  /** The structure hash of the frame that just ended (`GlSignatureRecorder.lastHash`), where recorded. */
  frameHash?(): string | null;
  /** Fences that have split a pass so far (`GlSignatureRecorder.fenceSplits`), where recorded. */
  fenceSplits?(): number;
  /**
   * Runs `submit` where a fence splits no pass: as the next pass starts (`GlSignatureRecorder.onPassStart`), or at the
   * frame's end. A stage boundary is not always a pass boundary: a capture's own shadow maps draw into the atlas the
   * scene's maps just drew into, and a fence and flush between the two would end the GPU's pass on it and make the
   * next one load what the first stored. Absent, a stage is fenced where it ends.
   */
  deferFence?(submit: () => void): void;
}

/**
 * A stage's median over the probe's warm frames. Censored: its fence had already signalled at the frame's first poll
 * (in most of the frames), so it finished while the frame was still being submitted and `ms` is an upper bound, the
 * time from its fence's submission to that poll.
 */
export interface SerialStageResult {
  stage: FrameStage;
  ms: number;
  censored: boolean;
}

export interface SerialProbeResult {
  /** Increments with every probe run, so a reader can tell a new result. */
  id: number;
  /** Frames measured (the first, cold, among them). */
  frames: number;
  /** Median over the frames after the first: first fence submitted to last fence done (whole-frame GPU, floored by `cpuMs`). */
  frameMs: number | null;
  /** The first frame's, after the drain: cold. */
  coldMs: number | null;
  /** Median CPU submission: the first fence to the last one submitted. A stage done before it ended reads censored. */
  cpuMs: number | null;
  stages: SerialStageResult[];
  /** The synthetic load: median of its warm runs, and its first run. */
  syntheticMs: number | null;
  syntheticColdMs: number | null;
  /** The structure hash of each frame measured, where the GL signature was recorded. */
  hashes: string[];
  /** Stage fences that split a pass in two over the probe's frames (0 when every one fell between passes); null unrecorded. */
  splits: number | null;
  /** Why it stopped early; null when it finished. */
  failed: string | null;
  /** How long the probe held rendering. */
  ms: number;
}

/** Frames a probe measures: the first is cold, after the drain. */
export const SERIAL_PROBE_FRAMES = 8;
/** Synthetic load runs: the first is cold. */
export const SYNTHETIC_RUNS = 6;
/** Longest a probe waits for any one fence, or for the synthetic program to compile. */
const SERIAL_PROBE_TIMEOUT_MS = 3000;
/** Longest a probe waits, from its start, for the view to draw its frames (a view that holds or stops drawing). */
const SERIAL_PROBE_FRAMES_TIMEOUT_MS = 5000;

interface StageFence { stage: FrameStage; submitted: number; fence: ProbeFence; done: number | null }
interface ProbeFrame {
  started: number;
  ended: number;
  drawn: boolean;
  start: { fence: ProbeFence; done: number | null };
  stages: StageFence[];
  firstPoll: number | null;
  hash: string | null;
}

type SerialState = "idle" | "draining" | "waiting" | "rendering" | "completing" | "synthetic";

/**
 * Serialised frames with stage fences, and the synthetic load (`gpuprobe serial`). The frame loop asks `holding` before
 * it renders, calls `frameStarted` once a frame renders, `stage` at each draw pass boundary, `frameDrawn` when the frame
 * was drawn whole, and `frameEnded` at the Engine's frame end.
 *
 * WebGL2 fences signal only once the task that submitted them has returned, so a stage done before the frame's task
 * ended is first seen at the first poll: it reads as at most the time to that poll (`censored`).
 */
export class SerialFrameProbe {
  private state: SerialState = "idle";
  private readonly host: SerialProbeHost;
  private readonly framesWanted: number;
  private drain: { fence: ProbeFence; since: number } | null = null;
  private frame: ProbeFrame | null = null;
  private stage: FrameStage = "other";
  private tailReached = false;
  private readonly measured: ProbeFrame[] = [];
  private synthetic: { fence: ProbeFence; submitted: number } | null = null;
  private syntheticSince = 0;
  private readonly syntheticMs: number[] = [];
  private started = 0;
  private splitsBefore = 0;
  private runs = 0;
  private last: SerialProbeResult | null = null;
  private pollScheduled = false;

  constructor(host: SerialProbeHost, frames = SERIAL_PROBE_FRAMES) {
    this.host = host;
    this.framesWanted = frames;
  }

  /** Starts a probe; false while one runs or without fences. */
  request(): boolean {
    if (this.state !== "idle") return false;
    const fence = this.host.fence();
    if (!fence) {
      this.finish("no fences");
      return false;
    }
    this.measured.length = 0;
    this.syntheticMs.length = 0;
    this.started = this.host.now();
    this.splitsBefore = this.host.fenceSplits?.() ?? 0;
    this.drain = { fence, since: this.started };
    this.state = "draining";
    this.requestPoll();
    return true;
  }

  get running(): boolean { return this.state !== "idle"; }

  /** Whether the frame loop must not render now: the probe is draining, measuring a frame or running its load. */
  get holding(): boolean { return this.state !== "idle" && this.state !== "waiting"; }

  /** Whether the probe is inside a frame: draw pass boundaries are stage boundaries. */
  get inFrame(): boolean { return this.state === "rendering"; }

  result(): SerialProbeResult | null { return this.last; }

  /**
   * Ends a probe whose view has not drawn its frames in time, with what it measured. The frame loop calls it as each
   * Engine frame begins: between frames the probe polls nothing.
   */
  expire(): void {
    if (this.state === "waiting" && this.host.now() - this.started > SERIAL_PROBE_FRAMES_TIMEOUT_MS) this.finish("the view drew too few frames");
  }

  frameStarted(): void {
    if (this.state !== "waiting") return;
    const fence = this.host.fence();
    if (!fence) {
      this.finish("no fences");
      return;
    }
    const now = this.host.now();
    this.frame = { started: now, ended: now, drawn: false, start: { fence, done: null }, stages: [], firstPoll: null, hash: null };
    this.stage = "other";
    this.tailReached = false;
    this.state = "rendering";
  }

  /** A draw pass boundary: the pass running now. A change of stage fences the one before. */
  stageBoundary(pass: DrawPass | "tail"): void {
    if (this.state !== "rendering") return;
    if (pass === "tail") this.tailReached = true;
    let next = frameStageOf(pass);
    if (next === null) return;
    if (this.tailReached && (next === "main" || next === "effects")) next = "tail";
    if (next === this.stage) return;
    this.fenceStage();
    this.stage = next;
  }

  frameDrawn(): void { if (this.frame && this.state === "rendering") this.frame.drawn = true; }

  /** The Engine's frame end, with every deferred fence already submitted by the host: the last stage is fenced here. */
  frameEnded(): void {
    if (this.state !== "rendering" || !this.frame) return;
    const fence = this.host.fence();
    if (fence) this.frame.stages.push({ stage: this.stage, submitted: this.host.now(), fence, done: null });
    this.frame.ended = this.host.now();
    this.frame.hash = this.host.frameHash?.() ?? null;
    this.state = "completing";
    this.requestPoll();
  }

  /** Reads fences without blocking; run by the probe's own loop, exposed for tests. */
  poll(): void {
    this.pollScheduled = false;
    const now = this.host.now();
    if (this.state === "draining") this.pollDrain(now);
    else if (this.state === "completing") this.pollFrame(now);
    else if (this.state === "synthetic") this.pollSynthetic(now);
    if (this.state === "draining" || this.state === "completing" || this.state === "synthetic") this.requestPoll();
  }

  dispose(): void {
    this.drain?.fence.dispose();
    this.disposeFrame(this.frame);
    this.synthetic?.fence.dispose();
    this.drain = this.frame = this.synthetic = null;
    this.state = "idle";
  }

  /**
   * Fences the stage that just ended. With a host that defers, the fence waits for the next pass to start, so what
   * the new stage draws until then counts to the stage before it.
   */
  private fenceStage(): void {
    const frame = this.frame!;
    const stage = this.stage;
    const submit = () => {
      if (this.frame !== frame || this.state !== "rendering") return;
      const fence = this.host.fence();
      if (fence) frame.stages.push({ stage, submitted: this.host.now(), fence, done: null });
    };
    if (this.host.deferFence) this.host.deferFence(submit);
    else submit();
  }

  private pollDrain(now: number): void {
    const drain = this.drain!;
    const done = drain.fence.done();
    if (done === null) return this.finish("lost context");
    if (!done || !this.host.drained()) {
      if (now - drain.since > SERIAL_PROBE_TIMEOUT_MS) this.finish("the GPU did not drain");
      return;
    }
    drain.fence.dispose();
    this.drain = null;
    this.state = "waiting";
  }

  private pollFrame(now: number): void {
    const frame = this.frame!;
    frame.firstPoll ??= now;
    const fences = [frame.start, ...frame.stages];
    for (const entry of fences) {
      if (entry.done !== null) continue;
      const done = entry.fence.done();
      if (done === null) return this.finish("lost context");
      if (!done) {
        if (now - frame.ended > SERIAL_PROBE_TIMEOUT_MS) this.finish("a frame did not finish");
        return;
      }
      entry.done = now;
    }
    this.disposeFrame(frame);
    this.frame = null;
    if (frame.drawn) this.measured.push(frame);
    if (this.measured.length < this.framesWanted) {
      this.state = "waiting";
      return;
    }
    if (!this.host.synthetic) return this.finish(null);
    this.state = "synthetic";
    this.syntheticSince = now;
  }

  private pollSynthetic(now: number): void {
    const synthetic = this.host.synthetic!;
    if (this.synthetic) {
      const done = this.synthetic.fence.done();
      if (done === null) return this.finish("lost context");
      if (!done) {
        if (now - this.synthetic.submitted > SERIAL_PROBE_TIMEOUT_MS) this.finish("the synthetic load did not finish");
        return;
      }
      this.syntheticMs.push(now - this.synthetic.submitted);
      this.synthetic.fence.dispose();
      this.synthetic = null;
      if (this.syntheticMs.length >= SYNTHETIC_RUNS) return this.finish(null);
    }
    if (!synthetic.ready()) {
      if (now - this.syntheticSince > SERIAL_PROBE_TIMEOUT_MS) this.finish("the synthetic load did not compile");
      return;
    }
    synthetic.draw();
    const fence = this.host.fence();
    if (!fence) return this.finish("no fences");
    this.synthetic = { fence, submitted: this.host.now() };
  }

  private finish(failed: string | null): void {
    this.runs += 1;
    const splits = this.host.fenceSplits ? this.host.fenceSplits() - this.splitsBefore : null;
    this.last = summariseSerialProbe(this.measured, this.syntheticMs, failed, this.runs, this.host.now() - this.started, splits);
    this.dispose();
  }

  private disposeFrame(frame: ProbeFrame | null): void {
    if (!frame) return;
    frame.start.fence.dispose();
    for (const stage of frame.stages) stage.fence.dispose();
  }

  private requestPoll(): void {
    if (this.pollScheduled) return;
    this.pollScheduled = true;
    this.host.schedule(() => this.poll());
  }
}

/**
 * A frame's per-stage GPU time. The GPU runs the stages in order, so a stage starts at the later of its own submission
 * and the end of the one before, and its time is its completion minus that. Completions are seen at polls, the first
 * one after the frame's task: a stage whose fence had already signalled then is censored. It ended somewhere between
 * its submission and that poll, so it reads as that whole span, an upper bound, and the stage after it is taken to have
 * started no earlier than its own submission. A stage's censored parts count once, by the longest.
 */
function frameStages(frame: ProbeFrame): Map<FrameStage, { ms: number; censored: boolean }> {
  const stages = new Map<FrameStage, { measured: number; bound: number; censored: boolean }>();
  let previous = frame.started;
  for (const entry of frame.stages) {
    const censored = entry.done! <= (frame.firstPoll ?? -Infinity);
    const ms = Math.max(0, entry.done! - Math.max(previous, entry.submitted));
    const total = stages.get(entry.stage) ?? { measured: 0, bound: 0, censored: false };
    // A stage fenced more than once (main, the effects, then main again): its censored parts all ended before the same
    // poll, so together they took at most the longest of their spans, not the sum.
    if (censored) total.bound = Math.max(total.bound, ms);
    else total.measured += ms;
    total.censored ||= censored;
    stages.set(entry.stage, total);
    previous = censored ? entry.submitted : entry.done!;
  }
  return new Map([...stages].map(([stage, total]) => [stage, { ms: total.measured + total.bound, censored: total.censored }]));
}

/** The result of a probe's frames and synthetic runs (`SerialProbeResult`). */
export function summariseSerialProbe(
  frames: readonly ProbeFrame[], synthetic: readonly number[], failed: string | null, id: number, ms: number, splits: number | null = null,
): SerialProbeResult {
  const span = (frame: ProbeFrame) => frame.stages.length ? frame.stages[frame.stages.length - 1]!.done! - frame.started : null;
  const warm = frames.slice(1);
  const values = (read: (frame: ProbeFrame) => number | null) => warm.flatMap((frame) => { const value = read(frame); return value === null ? [] : [value]; });
  const perFrame = warm.map(frameStages);
  const stages: SerialStageResult[] = [];
  for (const stage of FRAME_STAGES) {
    const entries = perFrame.flatMap((map) => map.has(stage) ? [map.get(stage)!] : []);
    if (!entries.length) continue;
    const censored = entries.filter((entry) => entry.censored).length * 2 > entries.length;
    stages.push({ stage, ms: median(entries.map((entry) => entry.ms))!, censored });
  }
  return {
    id, frames: frames.length, frameMs: median(values(span)), coldMs: frames[0] ? span(frames[0]) : null,
    cpuMs: median(values((frame) => frame.stages.length ? frame.stages[frame.stages.length - 1]!.submitted - frame.started : null)),
    stages, syntheticMs: median(synthetic.slice(1)), syntheticColdMs: synthetic[0] ?? null,
    hashes: frames.flatMap((frame) => frame.hash ? [frame.hash] : []), splits, failed, ms,
  };
}

/** Schedules callbacks as MessageChannel messages: a polling loop at well under a millisecond, with no timer clamp. */
export function messageChannelScheduler(): { schedule: (callback: () => void) => void; dispose: () => void } {
  const channel = new MessageChannel();
  const queue: (() => void)[] = [];
  channel.port1.onmessage = () => queue.shift()?.();
  return {
    schedule: (callback) => {
      queue.push(callback);
      channel.port2.postMessage(null);
    },
    dispose: () => {
      queue.length = 0;
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
    },
  };
}
