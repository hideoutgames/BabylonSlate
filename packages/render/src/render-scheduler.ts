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
 * world). A frame on a 60 Hz display is well under it. One such frame may be a long task after it; two in a row hold
 * frames back.
 */
const HELD_THREAD_MS = 500;
/** The most a held frame leaves the main thread free for, so a suspension read as a held frame costs one short pause. */
const HELD_THREAD_YIELD_MAX_MS = 1000;

/**
 * With Half Rate When Idle on (`setIdleHalfRate`), a view draws at half its frame cap once this long has passed
 * without activity. Long enough that a pause between two gestures or edits stays at the full cap.
 */
export const IDLE_HALF_RATE_DELAY_MS = 1000;

/**
 * Dirty-driven render scheduler with refcounted continuous-render leases.
 * Visible editor viewports always render continuously plus a frame cap, at half
 * the cap while idle when Half Rate When Idle is on; freeze when paused, not
 * visible, obstructed, or resizing.
 *
 * Activity, for Half Rate When Idle, is any signal the scheduler receives:
 * `invalidate`, `noteActivity`, `requestPausedFrame`, a held render lease and its
 * release, `setPaused`, `setResizing`, `setObstructed`, the view being shown
 * again, and turning the setting on. A signal raised while a frame draws (between
 * the `shouldRender` that admitted it and `noteRendered`) is that frame's own
 * animation, such as editor cables stepping, and is not activity.
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
  /** Frames in a row that held the main thread past their own work. */
  private heldFrames = 0;
  /** Until when frames hold back after a frame held the main thread (`HELD_THREAD_MS`). */
  private heldYieldUntil = 0;
  /** Half Rate When Idle; only editor viewports turn it on (`viewport-render-gate.ts`). */
  private idleHalfRate = false;
  /** Activity since the last gate check, which timestamps it on the caller's clock. */
  private activityPending = true;
  private lastActivityAt: number | null = null;
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
    this.activityPending = true;
    this.invalidations += 1;
    this.invalidationsThisSecond += 1;
  }

  /**
   * Activity that needs no redraw of its own but must not be met at half rate: input over the view, camera motion,
   * loading, held frames, captures and readbacks. See `setIdleHalfRate`.
   */
  noteActivity(): void {
    this.activityPending = true;
  }

  acquireContinuous(_reason: string): () => void {
    void _reason;
    this.continuous += 1;
    this.activityPending = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.continuous = Math.max(0, this.continuous - 1);
      this.activityPending = true;
    };
  }

  setAlwaysRender(value: boolean): void {
    this.alwaysRender = value;
  }

  /**
   * Half Rate When Idle: after `IDLE_HALF_RATE_DELAY_MS` without activity the view draws at half its frame cap, and the
   * first activity returns it to the full cap at its next full-rate slot. A held render lease never idles.
   */
  setIdleHalfRate(value: boolean): void {
    if (value !== this.idleHalfRate) this.activityPending = true;
    this.idleHalfRate = value;
  }

  setPaused(value: boolean): void {
    if (value !== this.paused) {
      this.lastRenderAt = null;
      this.nextRenderAt = null;
      this.forgetHeldThread();
      this.activityPending = true;
    }
    this.paused = value;
  }

  setVisible(value: boolean): void {
    if (value !== this.visible) {
      this.forgetHeldThread();
      this.activityPending = true;
    }
    this.visible = value;
  }

  setDocumentVisible(value: boolean): void {
    if (value !== this.documentVisible) {
      this.forgetHeldThread();
      this.activityPending = true;
    }
    this.documentVisible = value;
  }

  /** Present a completed simulation step without resuming continuous drawing. */
  requestPausedFrame(): void {
    this.pausedFrameRequested = true;
    this.dirty = true;
    this.activityPending = true;
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
    if (value !== this.obstructed) this.activityPending = true;
    this.obstructed = value;
  }

  setResizing(value: boolean): void {
    if (value !== this.resizing) this.activityPending = true;
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
    if (this.activityPending) {
      this.activityPending = false;
      this.lastActivityAt = now;
    }
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
    // Half rate keeps the full-rate cadence (`nextRenderAt`) and skips the slot after each frame, so the first activity
    // draws at the next full-rate slot instead of waiting for a half-rate one. A quarter-slot tolerance absorbs callback
    // jitter and a frame that began after its admission check, while still skipping the in-between callback of a
    // display faster than the cap.
    if (this.lastRenderAt !== null && this.isHalfRate(now)) {
      const minDelta = 1000 / this.frameCap;
      if (now + minDelta / 4 < this.lastRenderAt + 2 * minDelta) return false;
    }
    return true;
  }

  /** Whether the view is drawing at half its frame cap: Half Rate When Idle is on and it has been idle long enough. */
  isHalfRate(now: number = nowMs()): boolean {
    if (!this.idleHalfRate || this.continuous > 0 || this.activityPending || this.pausedFrameRequested) return false;
    return this.lastActivityAt !== null && now - this.lastActivityAt >= IDLE_HALF_RATE_DELAY_MS;
  }

  /**
   * Frames that hold the main thread after their own work (software GL with software compositing waits there for the
   * GPU to finish each frame), back to back, starve every other task of the page (input, timers, worker replies, a test
   * driver's commands): from the second in a row, each leaves the thread free for as long, up to a limit, before the
   * next frame. Read once, at the first check after the frame.
   */
  private readHeldThread(now: number): void {
    if (!this.awaitingNextCheck || this.lastFrameEndedAt === null) return;
    this.awaitingNextCheck = false;
    const held = now - this.lastFrameEndedAt;
    this.heldFrames = held >= HELD_THREAD_MS ? this.heldFrames + 1 : 0;
    if (this.heldFrames >= 2) this.heldYieldUntil = now + Math.min(held, HELD_THREAD_YIELD_MAX_MS);
  }

  private forgetHeldThread(): void {
    this.awaitingNextCheck = false;
    this.heldFrames = 0;
  }

  /** `now` is when the frame began (its cadence slot); `endedAt` when its work finished. */
  noteRendered(now: number = nowMs(), endedAt: number = now): void {
    this.lastFrameEndedAt = endedAt;
    this.lastFrameMs = Math.max(0, endedAt - now);
    this.awaitingNextCheck = true;
    this.rollStats();
    this.dirty = false;
    this.pausedFrameRequested = false;
    // Raised by this frame's own drawing, not by the user (see the class comment).
    this.activityPending = false;
    if (this.continuous > 0 || this.lastActivityAt === null) this.lastActivityAt = now;
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

  /** Snapshot the gates that can hold a ready viewport without drawing. `frameCap` is the configured cap; `halfRate` says whether it is halved now. */
  gateState(now: number = nowMs()) {
    return {
      idleHalfRate: this.idleHalfRate,
      halfRate: this.isHalfRate(now),
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
