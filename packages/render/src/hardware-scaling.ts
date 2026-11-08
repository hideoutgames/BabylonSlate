import type { ResolutionQuality } from "@haptic/core";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

/**
 * Per-view frame cost, measured across one rendered (non-loading) frame.
 * `presentationMs` is the interval since the view's previous presented frame —
 * `null` when that interval is unknown (skipped/capped/hidden/loading frames
 * break the chain). `gpuMs` is the engine GPU frame time — `null` whenever it
 * is unavailable or shared with sibling registered views. Unknown is never 0.
 */
export interface FramePressureSample {
  presentationMs: number | null;
  cpuMs: number;
  gpuMs: number | null;
}

/** Samples the valve's medians span. */
const PRESSURE_WINDOW = 15;

interface HardwareScalingOptions {
  minLevel?: number;
  maxLevel?: number;
  targetFrameMs?: number;
  cooldownFrames?: number;
  initialLevel?: number;
  /**
   * Where the level takes effect; the Engine's hardware scaling by default. Play passes its world output,
   * so the level scales the world alone and the backbuffer Scene Layers draw into keeps full resolution.
   */
  apply?: (level: number) => void;
}

/**
 * Owns resolution via setHardwareScalingLevel, or through `apply`. Engine must be
 * constructed with adaptToDeviceRatio: false.
 */
export class HardwareScalingController {
  private readonly apply: (level: number) => void;
  private minLevel: number;
  private maxLevel: number;
  private targetFrameMs: number;
  private readonly cooldownFrames: number;
  private level: number;
  private cooldown = 0;
  private dynamic = true;
  /**
   * The last `PRESSURE_WINDOW` samples, as values: fixed rings written in place, so a presented frame allocates
   * nothing and no caller's sample object is kept. A null presentation or GPU time is NaN.
   */
  private readonly pressure = new Float64Array(PRESSURE_WINDOW);
  private readonly presentation = new Float64Array(PRESSURE_WINDOW);
  private readonly cpu = new Float64Array(PRESSURE_WINDOW);
  private readonly gpu = new Float64Array(PRESSURE_WINDOW);
  private sampleCount = 0;
  private nextSample = 0;
  /** Median scratch. */
  private readonly sorted = new Float64Array(PRESSURE_WINDOW);
  /**
   * Raise backoff: frames a raise waits after the last drop. A drop within two
   * cooldowns of a raise, with most frames since it over budget, doubles it: the
   * raised level does not fit, so the load settles at the lower one instead of
   * flipping (each flip resizes the output, which rebuilds a view's frame graph).
   * Any other drop (a passing hitch after a raise that held) and a raise that
   * follows a held raise clear it.
   */
  private raiseWait = 0;
  private sinceRaise = Number.POSITIVE_INFINITY;
  private sinceDrop = Number.POSITIVE_INFINITY;
  private heavySinceRaise = 0;

  constructor(engine: AbstractEngine, options: HardwareScalingOptions = {}) {
    this.apply = options.apply ?? ((level) => engine.setHardwareScalingLevel(level));
    this.minLevel = options.minLevel ?? 1;
    this.maxLevel = options.maxLevel ?? 2;
    this.targetFrameMs = options.targetFrameMs ?? 1000 / 60;
    this.cooldownFrames = options.cooldownFrames ?? 30;
    this.level = Number.NaN;
    this.setLevel(options.initialLevel ?? 1);
  }

  configureQuality(settings: ResolutionQuality): void {
    this.minLevel = 1 / settings.scale;
    this.maxLevel = 1 / Math.min(settings.scale, settings.minScale);
    this.targetFrameMs = 1000 / settings.targetFps;
    this.dynamic = settings.dynamic;
    this.clearSamples();
    this.resetRaiseBackoff();
    this.setLevel(this.minLevel);
  }

  getLevel(): number {
    return this.level;
  }

  /**
   * Engine Settings hardware scaling is both the current level and the valve
   * floor. Live settings changes must call this so cheap frames cannot hunt
   * back below the user's choice.
   */
  setSettingsLevel(level: number): void {
    if (!Number.isFinite(level) || level <= 0) return;
    this.minLevel = Math.min(this.maxLevel, level);
    this.resetRaiseBackoff();
    this.setLevel(level);
  }

  setLevel(level: number): void {
    const next = Math.min(this.maxLevel, Math.max(this.minLevel, level));
    if (next === this.level) return;
    this.level = next;
    this.apply(this.level);
  }

  /**
   * WebGL restore: return to the Engine Settings floor and forget hitch
   * samples so a long `loadScene` cannot ratchet toward maxLevel.
   */
  noteRestore(): void {
    this.clearSamples();
    this.cooldown = this.cooldownFrames;
    this.resetRaiseBackoff();
    this.setLevel(this.minLevel);
  }

  private clearSamples(): void {
    this.sampleCount = 0;
    this.nextSample = 0;
  }

  private resetRaiseBackoff(): void {
    this.raiseWait = 0;
    this.sinceRaise = Number.POSITIVE_INFINITY;
    this.sinceDrop = Number.POSITIVE_INFINITY;
    this.heavySinceRaise = 0;
  }

  noteFramePressure(sample: FramePressureSample): void {
    if (!this.dynamic) return;
    this.sinceRaise += 1;
    this.sinceDrop += 1;
    const pressure = pressureOf(sample);
    if (pressure > this.targetFrameMs * 1.15) this.heavySinceRaise += 1;
    const slot = this.nextSample;
    this.pressure[slot] = pressure;
    this.presentation[slot] = sample.presentationMs ?? Number.NaN;
    this.cpu[slot] = sample.cpuMs;
    this.gpu[slot] = sample.gpuMs ?? Number.NaN;
    this.nextSample = (slot + 1) % PRESSURE_WINDOW;
    if (this.sampleCount < PRESSURE_WINDOW) this.sampleCount += 1;
    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }
    const count = this.sampleCount;
    if (count < 5) return;
    const medianPressure = this.median(this.pressure, count);
    if (medianPressure > this.targetFrameMs * 1.15 && this.level < this.maxLevel) {
      const raisedLevelDidNotFit =
        this.sinceRaise <= this.cooldownFrames * 2 && this.heavySinceRaise * 2 >= this.sinceRaise;
      this.raiseWait = raisedLevelDidNotFit
        ? Math.min(this.cooldownFrames * 16, Math.max(this.cooldownFrames, this.raiseWait * 2))
        : 0;
      this.setLevel(this.level + 0.25);
      this.cooldown = this.cooldownFrames;
      this.sinceDrop = 0;
      return;
    }
    if (this.sinceDrop < this.raiseWait) return;
    // Quality only climbs back when every signal proves headroom: real
    // presentation intervals at the target cadence for the whole window plus
    // CPU (and GPU when it is attributable) inside the headroom margin. An
    // unknown GPU is never read as free time. Views that never report
    // presentation intervals (free-running editor viewports) fall back to the
    // cost-only headroom rule; a partially unknown window still blocks.
    let presented = 0;
    let presentedAtTarget = 0;
    for (let index = 0; index < count; index++) {
      const presentation = this.presentation[index]!;
      if (Number.isNaN(presentation)) continue;
      presented += 1;
      if (presentation <= this.targetFrameMs * 1.05) presentedAtTarget += 1;
    }
    const presentationAtTarget = presented === 0 || presentedAtTarget === count;
    if (!presentationAtTarget) return;
    // NaN when no sample has an attributable GPU time.
    const gpuMedian = this.median(this.gpu, count, true);
    if (
      this.median(this.cpu, count) < this.targetFrameMs * 0.7 &&
      (Number.isNaN(gpuMedian) || gpuMedian < this.targetFrameMs * 0.7) &&
      this.level > this.minLevel
    ) {
      // The previous raise held: nothing dropped since it.
      if (this.sinceDrop > this.sinceRaise) this.raiseWait = 0;
      this.setLevel(this.level - 0.25);
      this.cooldown = this.cooldownFrames;
      this.sinceRaise = 0;
      this.heavySinceRaise = 0;
    }
  }

  /**
   * The median of a ring's first `count` values (the upper one of an even count), or with `known` of its non-NaN
   * values, NaN when it has none. The scratch's unused slots hold +Infinity, which sorts after every value.
   */
  private median(ring: Float64Array, count: number, known = false): number {
    const sorted = this.sorted;
    let length = 0;
    for (let index = 0; index < count; index++) {
      const value = ring[index]!;
      if (!known || !Number.isNaN(value)) sorted[length++] = value;
    }
    if (length === 0) return Number.NaN;
    sorted.fill(Number.POSITIVE_INFINITY, length);
    // A typed array sorts numerically.
    sorted.sort();
    return sorted[length >> 1]!;
  }
}

function pressureOf(entry: FramePressureSample): number {
  return Math.max(entry.presentationMs ?? 0, entry.cpuMs, entry.gpuMs ?? 0);
}
