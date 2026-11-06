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

export interface HardwareScalingOptions {
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
  private samples: FramePressureSample[] = [];
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
    this.samples = [];
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
    this.samples = [];
    this.cooldown = this.cooldownFrames;
    this.resetRaiseBackoff();
    this.setLevel(this.minLevel);
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
    if (pressureOf(sample) > this.targetFrameMs * 1.15) this.heavySinceRaise += 1;
    this.samples.push(sample);
    if (this.samples.length > 15) this.samples.shift();
    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }
    if (this.samples.length < 5) return;
    const medianPressure = medianOf(this.samples.map(pressureOf));
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
    const noPresentationEvidence = this.samples.every(
      (entry) => entry.presentationMs == null,
    );
    const presentationAtTarget =
      noPresentationEvidence ||
      this.samples.every(
        (entry) =>
          entry.presentationMs != null &&
          entry.presentationMs <= this.targetFrameMs * 1.05,
      );
    if (!presentationAtTarget) return;
    const gpuSamples = this.samples.flatMap((entry) =>
      entry.gpuMs != null ? [entry.gpuMs] : [],
    );
    if (
      medianOf(this.samples.map((entry) => entry.cpuMs)) <
        this.targetFrameMs * 0.7 &&
      (gpuSamples.length === 0 ||
        medianOf(gpuSamples) < this.targetFrameMs * 0.7) &&
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
}

function pressureOf(entry: FramePressureSample): number {
  return Math.max(entry.presentationMs ?? 0, entry.cpuMs, entry.gpuMs ?? 0);
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
