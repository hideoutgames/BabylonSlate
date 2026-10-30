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
 * A rendered frame whose next callback comes this long after its work ended held the main thread past its own work: on
 * software GL with software compositing the browser waits there for the GPU to finish the frame (seconds for a large
 * world). A frame on a 60 Hz display is well under it.
 */
const HELD_THREAD_MS = 500;
/** The most a held frame leaves the main thread free for, so a suspension read as a held frame costs one short pause. */
const HELD_THREAD_YIELD_MAX_MS = 1000;

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
  private obstructionLeases = 0;
  private resizing = false;
  private frameCap = Number.POSITIVE_INFINITY;
  private lastRenderAt: number | null = null;
  private nextRenderAt: number | null = null;
  /** When the last frame ended and how long it took, for ready owners' yield under a load. */
  private lastFrameEndedAt: number | null = null;
  private lastFrameMs = 0;
  /** A frame rendered since the last gate check: the next check reads how long the thread was held after it. */
  private awaitingNextCheck = false;
  /** Until when frames hold back after a frame held the main thread (`HELD_THREAD_MS`). */
  private heldYieldUntil = 0;
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
      this.awaitingNextCheck = false;
    }
    this.paused = value;
  }

  setVisible(value: boolean): void {
    if (value !== this.visible) this.awaitingNextCheck = false;
    this.visible = value;
  }

  setDocumentVisible(value: boolean): void {
    if (value !== this.documentVisible) this.awaitingNextCheck = false;
    this.documentVisible = value;
  }

  /** Present a completed simulation step without resuming continuous drawing. */
  requestPausedFrame(): void {
    this.pausedFrameRequested = true;
    this.dirty = true;
  }

  /** Whether the view's canvas is on screen, so it may draw into its Engine's frames. */
  isShown(): boolean {
    return this.documentVisible && this.visible;
  }

  /** A loading transaction may draw under its modal, but never a hidden view. */
  canPresentLoadingFrame(): boolean {
    return this.isShown() && !this.resizing;
  }

  /** Loading owns a blocker independently of other modal observers. */
  acquireObstruction(): () => void {
    this.obstructionLeases++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.obstructionLeases--;
    };
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

  /**
   * Ready owners may continue under a loading blocker, respecting Pause and cadence. Each of their frames then leaves
   * the main thread free for as long as it took, so a slow frame (a large world on a slow GPU or software GL) cannot
   * starve the load's own work of the thread; a frame that fits its cadence is not held back.
   */
  shouldRenderReadyOwners(now: number = nowMs()): boolean {
    this.readHeldThread(now);
    if (this.lastFrameEndedAt !== null && now < this.lastFrameEndedAt + this.lastFrameMs) return false;
    return this.shouldRender(now, true);
  }

  shouldRender(now: number = nowMs(), loadingOwners = false): boolean {
    this.readHeldThread(now);
    if (now < this.heldYieldUntil) return false;
    if (this.paused && !this.pausedFrameRequested) return false;
    if (!this.documentVisible || !this.visible || this.resizing) return false;
    if (!loadingOwners && (this.obstructed || this.obstructionLeases > 0)) return false;
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

  /**
   * A frame that held the main thread after its own work (software GL with software compositing waits there for the
   * GPU to finish the frame) leaves it free for as long, up to a limit, before the next frame: back to back, such frames
   * starve every other task of the page (input, timers, worker replies, a test driver's commands). Read once, at the
   * first check after the frame.
   */
  private readHeldThread(now: number): void {
    if (!this.awaitingNextCheck || this.lastFrameEndedAt === null) return;
    this.awaitingNextCheck = false;
    const held = now - this.lastFrameEndedAt;
    if (held >= HELD_THREAD_MS) this.heldYieldUntil = now + Math.min(held, HELD_THREAD_YIELD_MAX_MS);
  }

  /** `now` is when the frame began (its cadence slot); `endedAt` when its work finished. */
  noteRendered(now: number = nowMs(), endedAt: number = now): void {
    this.lastFrameEndedAt = endedAt;
    this.lastFrameMs = Math.max(0, endedAt - now);
    this.awaitingNextCheck = true;
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

  /** Snapshot the gates that can hold a ready viewport without drawing. */
  gateState() {
    return {
      paused: this.paused,
      pausedFrameRequested: this.pausedFrameRequested,
      documentVisible: this.documentVisible,
      visible: this.visible,
      obstructed: this.obstructed,
      obstructionLeases: this.obstructionLeases,
      resizing: this.resizing,
      alwaysRender: this.alwaysRender,
      continuous: this.continuous,
      dirty: this.dirty,
      frameCap: this.frameCap,
      nextRenderAt: this.nextRenderAt,
      lastRenderAt: this.lastRenderAt,
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
