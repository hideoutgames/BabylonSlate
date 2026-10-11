export interface LockPollSchedulerOptions {
  intervalMs: number;
  /** A returned promise keeps later ticks from overlapping it. */
  tick: () => void | Promise<void>;
}

export class LockPollScheduler {
  private readonly intervalMs: number;
  private readonly tick: () => void | Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Host visibility, independent of start/stop: a pause before start holds the first tick. */
  private paused = false;
  private inFlight = false;
  private rerun = false;

  constructor(options: LockPollSchedulerOptions) {
    this.intervalMs = options.intervalMs;
    this.tick = options.tick;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.fire();
  }

  stop(): void {
    this.running = false;
    this.rerun = false;
    this.clearTimer();
  }

  pause(): void {
    this.paused = true;
    this.clearTimer();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.fire();
  }

  requestImmediate(): void {
    this.fire();
  }

  private fire(): void {
    if (!this.running || this.paused) return;
    this.clearTimer();
    if (this.inFlight) {
      // Run once more after the current tick settles instead of racing it.
      this.rerun = true;
      return;
    }
    this.timer = setTimeout(() => {
      this.fire();
    }, this.intervalMs);
    const result: unknown = this.tick();
    if (!result || typeof (result as PromiseLike<void>).then !== "function") return;
    this.inFlight = true;
    const settle = () => {
      this.inFlight = false;
      if (!this.rerun) return;
      this.rerun = false;
      this.fire();
    };
    (result as PromiseLike<void>).then(settle, settle);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
