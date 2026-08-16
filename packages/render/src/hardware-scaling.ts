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
  private readonly minLevel: number;
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
    this.level = 1;
    this.setLevel(options.initialLevel ?? 1);
  }

  getLevel(): number {
    return this.level;
  }

  setLevel(level: number): void {
    this.level = Math.min(this.maxLevel, Math.max(this.minLevel, level));
    this.engine.setHardwareScalingLevel(this.level);
  }

  /** Drop one quality tier (increase scaling level) — used on context restore. */
  dropTier(): void {
    this.setLevel(this.level + 0.25);
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
