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
 * Visible editor viewports always render continuously plus a frame cap; freeze
 * when paused, not visible, obstructed, or resizing.
 */
export class RenderScheduler {
  private dirty = false;
  private continuous = 0;
  private alwaysRender = false;
  private paused = false;
  private pausedFrameRequested = false;
  private documentVisible = true;
  private visible = true;
  private obstructed = false;
  private resizing = false;
  private frameCap = Number.POSITIVE_INFINITY;
  private lastRenderAt: number | null = null;
  private nextRenderAt: number | null = null;
  private renderedFrames = 0;
  private invalidations = 0;
  private lastSecond = nowMs();
  private renderedThisSecond = 0;
  private invalidationsThisSecond = 0;
  private renderedFps = 0;
  private invalidationsPerSecond = 0;

  invalidate(_reason: InvalidationReason): void {
    void _reason;
    this.rollStats();
    this.dirty = true;
    this.invalidations += 1;
    this.invalidationsThisSecond += 1;
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
    if (value !== this.paused) {
      this.lastRenderAt = null;
      this.nextRenderAt = null;
    }
    this.paused = value;
  }

  setVisible(value: boolean): void {
    this.visible = value;
  }

  setDocumentVisible(value: boolean): void {
    this.documentVisible = value;
  }

  /** Present a completed simulation step without resuming continuous drawing. */
  requestPausedFrame(): void {
    this.pausedFrameRequested = true;
    this.dirty = true;
  }

  setObstructed(value: boolean): void {
    this.obstructed = value;
  }

  setResizing(value: boolean): void {
    this.resizing = value;
  }

  setFrameCap(fps: number): void {
    const cap = fps > 0 ? fps : 60;
    if (cap !== this.frameCap) {
      this.nextRenderAt =
        this.lastRenderAt === null ? null : this.lastRenderAt + 1000 / cap;
    }
    this.frameCap = cap;
  }

  shouldRender(now: number = nowMs()): boolean {
    if (this.paused && !this.pausedFrameRequested) return false;
    if (!this.documentVisible || !this.visible || this.obstructed || this.resizing) return false;
    const wants =
      this.alwaysRender || this.continuous > 0 || this.dirty;
    if (!wants) return false;
    if (this.nextRenderAt !== null) {
      const minDelta = 1000 / this.frameCap;
      // Browser callbacks jitter around fractional refresh boundaries. Permit
      // at most 1 ms early without letting that tolerance accumulate as drift.
      const tolerance = Math.min(1, minDelta * 0.05);
      if (now + tolerance < this.nextRenderAt) return false;
    }
    return true;
  }

  noteRendered(now: number = nowMs()): void {
    this.rollStats();
    this.dirty = false;
    this.pausedFrameRequested = false;
    const minDelta = 1000 / this.frameCap;
    const tolerance = Math.min(1, minDelta * 0.05);
    // Preserve the cadence when a callback is slightly late. After a long
    // suspension, rebase instead of accumulating catch-up frames.
    this.nextRenderAt =
      this.nextRenderAt !== null && now - this.nextRenderAt < minDelta - tolerance
        ? this.nextRenderAt + minDelta
        : now + minDelta;
    this.lastRenderAt = now;
    this.renderedFrames += 1;
    this.renderedThisSecond += 1;
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
    const elapsed = now - this.lastSecond;
    if (elapsed >= 1000) {
      this.renderedFps = Math.round((this.renderedThisSecond * 1000) / elapsed);
      this.invalidationsPerSecond = Math.round(
        (this.invalidationsThisSecond * 1000) / elapsed,
      );
      this.renderedThisSecond = 0;
      this.invalidationsThisSecond = 0;
      this.lastSecond = now;
    }
  }
}
