export type InvalidationReason =
  | "snapshot"
  | "camera"
  | "gizmo"
  | "selection"
  | "asset"
  | "play"
  | "manual";

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Dirty-driven render scheduler with refcounted continuous-render leases.
 * Visible editor viewports also honor Always Render + a frame cap; freeze
 * when paused, not visible, or obstructed.
 */
export class RenderScheduler {
  private dirty = false;
  private continuous = 0;
  private alwaysRender = false;
  private paused = false;
  private visible = true;
  private obstructed = false;
  private frameCap = 60;
  private lastRenderAt: number | null = null;
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

  setVisible(value: boolean): void {
    this.visible = value;
  }

  setObstructed(value: boolean): void {
    this.obstructed = value;
  }

  setFrameCap(fps: number): void {
    this.frameCap = fps > 0 ? fps : 60;
  }

  shouldRender(now: number = nowMs()): boolean {
    if (this.paused) return false;
    if (!this.visible || this.obstructed) return false;
    const wants =
      this.alwaysRender || this.continuous > 0 || this.dirty;
    if (!wants) return false;
    if (this.lastRenderAt !== null) {
      const minDelta = 1000 / this.frameCap;
      if (now - this.lastRenderAt < minDelta) return false;
    }
    return true;
  }

  noteRendered(now: number = nowMs()): void {
    this.dirty = false;
    this.lastRenderAt = now;
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
    const now = nowMs();
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
