import type { Engine } from "@babylonjs/core";

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
  private readonly engine: Engine;
  private minLevel: number;
  private readonly maxLevel: number;
  private readonly targetFrameMs: number;
  private readonly cooldownFrames: number;
  private level: number;
  private cooldown = 0;
  private samples: number[] = [];

  constructor(engine: Engine, options: HardwareScalingOptions = {}) {
    this.engine = engine;
    this.minLevel = options.minLevel ?? 1;
    this.maxLevel = options.maxLevel ?? 2;
    this.targetFrameMs = options.targetFrameMs ?? 1000 / 60;
    this.cooldownFrames = options.cooldownFrames ?? 30;
    this.level = Number.NaN;
    this.setLevel(options.initialLevel ?? 1);
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

  noteFrameTime(frameMs: number): void {
    this.samples.push(frameMs);
    if (this.samples.length > 15) this.samples.shift();
    if (this.cooldown > 0) {
      this.cooldown -= 1;
      return;
    }
    if (this.samples.length < 5) return;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    if (median > this.targetFrameMs * 1.15 && this.level < this.maxLevel) {
      this.setLevel(this.level + 0.25);
      this.cooldown = this.cooldownFrames;
    } else if (
      median < this.targetFrameMs * 0.7 &&
      this.level > this.minLevel
    ) {
      this.setLevel(this.level - 0.25);
      this.cooldown = this.cooldownFrames;
    }
  }
}
