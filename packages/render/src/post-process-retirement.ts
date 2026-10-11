/** CPU/native ownership; physical GPU frees are scheduled separately. */
export interface PostProcessRelease {
  whenDisposed(): Promise<void>;
  whenReleased(): Promise<void>;
}

/** Keep every retired generation alive until its actual release is confirmed. */
export class PostProcessRetirement {
  private readonly reported = new Set<Promise<void>>();
  private readonly released = new Set<Promise<void>>();
  private reportFailed = false;
  private releaseFailed = false;
  private reportError: unknown;
  private releaseError: unknown;

  add(owner: PostProcessRelease): void {
    this.track(owner.whenDisposed(), this.reported, (error) => {
      this.reportFailed = true;
      this.reportError ??= error;
    });
    this.track(owner.whenReleased(), this.released, (error) => {
      this.releaseFailed = true;
      this.releaseError ??= error;
    });
  }

  /** Also covers generations retired while the wait is in progress. */
  async whenDisposed(): Promise<void> {
    while (this.reported.size) await Promise.allSettled(this.reported);
    if (this.reportFailed) throw this.reportError;
  }

  /** Also covers generations retired while the wait is in progress. */
  async whenReleased(): Promise<void> {
    while (this.released.size) await Promise.allSettled(this.released);
    if (this.releaseFailed) throw this.releaseError;
  }

  /**
   * Synchronous check: every tracked actual release has confirmed. False while
   * a release is pending or after a release failure, so dependents can decide
   * between immediate cleanup and quarantine without awaiting.
   */
  get releasedConfirmed(): boolean {
    return this.released.size === 0 && !this.releaseFailed;
  }

  private track(work: Promise<void>, pending: Set<Promise<void>>, fail: (error: unknown) => void): void {
    pending.add(work);
    void work.then(
      () => { pending.delete(work); },
      (error: unknown) => { pending.delete(work); fail(error); },
    );
  }
}
