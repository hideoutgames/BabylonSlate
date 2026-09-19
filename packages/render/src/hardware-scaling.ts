import type { ResolutionQuality } from "@babylonslate/core";
import type { AbstractEngine } from "@babylonjs/core";

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
}

/**
 * Owns resolution via setHardwareScalingLevel. Engine must be constructed with
 * adaptToDeviceRatio: false.
 */
export class HardwareScalingController {
  private readonly engine: AbstractEngine;
  private minLevel: number;
  private maxLevel: number;
  private targetFrameMs: number;
  private readonly cooldownFrames: number;
  private level: number;
  private cooldown = 0;
  private dynamic = true;
  private samples: FramePressureSample[] = [];

  constructor(engine: AbstractEngine, options: HardwareScalingOptions = {}) {
    this.engine = engine;
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
    this.setLevel(level);
  }

  setLevel(level: number): void {
    const next = Math.min(this.maxLevel, Math.max(this.minLevel, level));
    if (next === this.level) return;
    this.level = next;
    this.engine.setHardwareScalingLevel(this.level);
  }

  /** Drop one quality tier (increase scaling level). */
  dropTier(): void {
    this.setLevel(this.level + 0.25);
  }

  /**
   * WebGL restore: return to the Engine Settings floor and forget hitch
   * samples so a long `loadScene` cannot ratchet toward maxLevel.
   */
  noteRestore(): void {
    this.samples = [];
    this.cooldown = this.cooldownFrames;
    this.setLevel(this.minLevel);
  }

  noteFramePressure(sample: FramePressureSample): void {
    if (!this.dynamic) return;
    this.samples.push(sample);
    if (this.samples.length > 15) this.samples.shift();
    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }
    if (this.samples.length < 5) return;
    const medianPressure = medianOf(
      this.samples.map((entry) =>
        Math.max(entry.presentationMs ?? 0, entry.cpuMs, entry.gpuMs ?? 0),
      ),
    );
    if (medianPressure > this.targetFrameMs * 1.15 && this.level < this.maxLevel) {
      this.setLevel(this.level + 0.25);
      this.cooldown = this.cooldownFrames;
      return;
    }
    // Quality only climbs back when every signal proves headroom: real
    // presentation intervals at the target cadence for the whole window plus
    // CPU (and GPU when it is attributable) inside the headroom margin. An
    // unknown GPU is never read as free time.
    const presentationAtTarget = this.samples.every(
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
      this.setLevel(this.level - 0.25);
      this.cooldown = this.cooldownFrames;
    }
  }
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
