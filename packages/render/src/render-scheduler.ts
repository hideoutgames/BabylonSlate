export type InvalidationReason =
  | "snapshot"
  | "camera"
  | "gizmo"
  | "selection"
  | "asset"
  | "play"
  | "manual";

/**
 * Dirty-driven render scheduler with refcounted continuous-render leases.
 */
export class RenderScheduler {
  private dirty = false;
  private continuous = 0;
  private alwaysRender = false;
  private paused = false;
  private renderedFrames = 0;
  private invalidations = 0;
  private lastSecond = 0;
  private renderedThisSecond = 0;
  private invalidationsThisSecond = 0;
  private renderedFps = 0;
  private invalidationsPerSecond = 0;

  invalidate(_reason: InvalidationReason): void {
    void _reason;
    this.dirty = true;
    this.invalidations += 1;
    this.invalidationsThisSecond += 1;
    this.rollStats();
  }

  acquireContinuous(_reason: string): () => void {
    void _reason;
    this.continuous += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.continuous = Math.max(0, this.continuous - 1);
    };
  }

  setAlwaysRender(value: boolean): void {
    this.alwaysRender = value;
  }

  setPaused(value: boolean): void {
    this.paused = value;
  }

  shouldRender(): boolean {
    if (this.paused) return false;
    if (this.alwaysRender) return true;
    if (this.continuous > 0) return true;
    return this.dirty;
  }

  noteRendered(): void {
    this.dirty = false;
    this.renderedFrames += 1;
    this.renderedThisSecond += 1;
    this.rollStats();
  }

  stats(): {
    renderedFrames: number;
    invalidations: number;
    renderedFps: number;
    invalidationsPerSecond: number;
  } {
    this.rollStats();
    return {
      renderedFrames: this.renderedFrames,
      invalidations: this.invalidations,
      renderedFps: this.renderedFps,
      invalidationsPerSecond: this.invalidationsPerSecond,
    };
  }

  private rollStats(): void {
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    if (this.lastSecond === 0) {
      this.lastSecond = now;
      return;
    }
    if (now - this.lastSecond >= 1000) {
      this.renderedFps = this.renderedThisSecond;
      this.invalidationsPerSecond = this.invalidationsThisSecond;
      this.renderedThisSecond = 0;
      this.invalidationsThisSecond = 0;
      this.lastSecond = now;
    }
  }
}
