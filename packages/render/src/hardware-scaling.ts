import type { ResolutionQuality } from "@haptic/core";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";

/** The coarsest level: a quarter of the resolution, the lowest Resolution Scale. */
const MAX_LEVEL = 4;

interface HardwareScalingOptions {
  initialLevel?: number;
  /**
   * Where the level takes effect; the Engine's hardware scaling by default. Play passes its world output,
   * so the level scales the world alone and the backbuffer Scene Layers draw into keeps full resolution.
   */
  apply?: (level: number) => void;
}

/**
 * Holds the view's static resolution level (1 / Resolution Scale, or the Engine Settings level) and applies it via
 * setHardwareScalingLevel, or through `apply`. The last of `configureQuality` and `setSettingsLevel` wins; the level
 * never changes on its own. Engine must be constructed with adaptToDeviceRatio: false.
 */
export class HardwareScalingController {
  private readonly apply: (level: number) => void;
  private level = Number.NaN;

  constructor(engine: AbstractEngine, options: HardwareScalingOptions = {}) {
    this.apply = options.apply ?? ((level) => engine.setHardwareScalingLevel(level));
    this.setLevel(options.initialLevel ?? 1);
  }

  /** Resolution Scale: the level becomes 1 / `scale`. */
  configureQuality(settings: ResolutionQuality): void {
    this.setLevel(1 / settings.scale);
  }

  getLevel(): number {
    return this.level;
  }

  /** Engine Settings hardware scaling: the level becomes `level`, until the next quality change. */
  setSettingsLevel(level: number): void {
    if (!Number.isFinite(level) || level <= 0) return;
    this.setLevel(level);
  }

  private setLevel(level: number): void {
    const next = Math.min(MAX_LEVEL, level);
    if (next === this.level) return;
    this.level = next;
    this.apply(this.level);
  }
}
