export interface LockPollSchedulerOptions {
  intervalMs: number;
  tick: () => void | Promise<void>;
}

export class LockPollScheduler {
  private readonly intervalMs: number;
  private readonly tick: () => void | Promise<void>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private paused = false;

  constructor(options: LockPollSchedulerOptions) {
    this.intervalMs = options.intervalMs;
    this.tick = options.tick;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.fire();
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    this.clearTimer();
  }

  pause(): void {
    if (!this.running) return;
    this.paused = true;
    this.clearTimer();
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.fire();
  }

  requestImmediate(): void {
    if (!this.running || this.paused) return;
    this.fire();
  }

  private fire(): void {
    this.clearTimer();
    void this.tick();
    if (!this.running || this.paused) return;
    this.timer = setTimeout(() => {
      this.fire();
    }, this.intervalMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
