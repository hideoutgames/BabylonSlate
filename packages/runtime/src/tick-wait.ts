/** Whether `value` can be waited on: a Promise, a `TickWait` or a latent entry point's result. */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return value !== null && (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * A wait that resumes its waiters the moment it settles, in the caller's stack, where a Promise
 * resumes them in a later microtask. The simulation's own waits (Delay, tweens) settle inside a
 * tick, so a latent graph continues in the tick its wait ended in, at that tick's place in the
 * frame, however many ticks one frame runs.
 *
 * It is a thenable: `await` and Promise code accept it (and then resume in a microtask as usual).
 * `then` on a settled wait calls back at once, and a callback that throws rejects the wait `then`
 * returned, so settling never throws into the system that settled it.
 */
export class TickWait<T> implements PromiseLike<T> {
  private settled: Settled<T> | null = null;
  private waiters: Array<(settled: Settled<T>) => void> | null = null;

  /** A wait `run` settles, now or later; a throw from `run` rejects it. */
  static start<T>(run: (resolve: (value: T | PromiseLike<T>) => void, reject: (error: unknown) => void) => void): TickWait<T> {
    const wait = new TickWait<T>();
    try {
      run((value) => wait.resolve(value), (error) => wait.settle({ ok: false, error }));
    } catch (error) {
      wait.settle({ ok: false, error });
    }
    return wait;
  }

  /** `value` as a wait: a thenable is followed (a `TickWait` synchronously), anything else is its result. */
  static from<T>(value: T | PromiseLike<T>): TickWait<T> {
    if (value instanceof TickWait) return value as TickWait<T>;
    const wait = new TickWait<T>();
    wait.resolve(value);
    return wait;
  }

  private resolve(value: T | PromiseLike<T>): void {
    if (this.settled) return;
    if (isThenable(value)) {
      try {
        value.then((result) => this.settle({ ok: true, value: result }), (error) => this.settle({ ok: false, error }));
      } catch (error) {
        this.settle({ ok: false, error });
      }
      return;
    }
    this.settle({ ok: true, value });
  }

  private settle(settled: Settled<T>): void {
    if (this.settled) return;
    this.settled = settled;
    const waiters = this.waiters;
    this.waiters = null;
    if (waiters) for (const waiter of waiters) waiter(settled);
  }

  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((error: unknown) => R2 | PromiseLike<R2>) | null,
  ): TickWait<R1 | R2> {
    const next = new TickWait<R1 | R2>();
    const run = (settled: Settled<T>): void => {
      try {
        if (settled.ok) next.resolve(onFulfilled ? onFulfilled(settled.value) : settled.value as unknown as R1);
        else if (onRejected) next.resolve(onRejected(settled.error));
        else next.settle(settled);
      } catch (error) {
        next.settle({ ok: false, error });
      }
    };
    if (this.settled) run(this.settled);
    else (this.waiters ??= []).push(run);
    return next;
  }
}
