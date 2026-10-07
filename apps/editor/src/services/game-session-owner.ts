/** Game lifetime is independent of the canvas or React surface presenting it. */
export type GameSessionMode = "play" | "simulate" | "preview";
export type GameSessionLifecycle = "idle" | "preparing" | "running" | "paused" | "stopping" | "retention-resolution" | "failure";

export interface GameSessionTicket {
  readonly generation: number;
  readonly mode: GameSessionMode;
  readonly signal: AbortSignal;
}

export interface GameSessionState {
  readonly generation: number;
  readonly mode: GameSessionMode | null;
  readonly lifecycle: GameSessionLifecycle;
  /** An unconfirmed native release keeps the shared Engine unavailable. */
  readonly quarantined: boolean;
  readonly error: string | null;
}

export interface GameSessionStopResult {
  readonly released: Promise<{ quarantined: boolean }>;
}

export class GameSessionCancelledError extends Error {
  constructor() {
    super("Game session preparation was cancelled.");
    this.name = "AbortError";
  }
}

/**
 * One admission/release authority for all game hosts. Closing presentation is not
 * proof of native release. No timeout here can turn a quarantined owner idle.
 */
export class GameSessionOwner<Result extends GameSessionStopResult> {
  private state: GameSessionState = {
    generation: 0, mode: null, lifecycle: "idle", quarantined: false, error: null,
  };
  private readonly listeners = new Set<() => void>();
  private current: {
    ticket: GameSessionTicket;
    abort: AbortController;
    stop?: () => Result | Promise<Result>;
    beforeStop?: () => Promise<boolean>;
    releaseBarrier?: Promise<{ quarantined: boolean }>;
    stopping?: Promise<Result | undefined>;
  } | null = null;

  readonly getSnapshot = (): GameSessionState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  canStart(): boolean {
    return !this.state.quarantined &&
      (this.state.lifecycle === "idle" || this.state.lifecycle === "failure");
  }

  begin(mode: GameSessionMode): GameSessionTicket | null {
    if (!this.canStart()) return null;
    const abort = new AbortController();
    const ticket = Object.freeze({ generation: this.state.generation + 1, mode, signal: abort.signal });
    this.current = { ticket, abort };
    this.publish({ generation: ticket.generation, mode, lifecycle: "preparing", quarantined: false, error: null });
    return ticket;
  }

  owns(ticket: GameSessionTicket): boolean {
    return this.current?.ticket === ticket;
  }

  isCurrent(ticket: GameSessionTicket): boolean {
    return this.owns(ticket) && !ticket.signal.aborted;
  }

  /** Check after I/O, before publishing its result or beginning dependent work. */
  async awaitCurrent<T>(ticket: GameSessionTicket, pending: Promise<T>): Promise<T> {
    const value = await pending;
    if (!this.isCurrent(ticket)) throw new GameSessionCancelledError();
    return value;
  }

  /** Outgoing authoring presentation may still own native resources during preparation. */
  holdRelease(ticket: GameSessionTicket, released: Promise<{ quarantined: boolean }>): boolean {
    if (!this.isCurrent(ticket) || this.state.lifecycle !== "preparing") return false;
    const previous = this.current!.releaseBarrier;
    this.current!.releaseBarrier = Promise.all([previous, released]).then(
      (releases) => ({ quarantined: releases.some((release) => release?.quarantined) }),
      () => ({ quarantined: true }),
    );
    return true;
  }

  attach(ticket: GameSessionTicket, stop: () => Result | Promise<Result>): boolean {
    if (!this.isCurrent(ticket) || this.state.lifecycle !== "preparing") return false;
    this.current!.stop = stop;
    this.publish({ ...this.state, lifecycle: "running" });
    return true;
  }

  /** Retention admission must resolve before abort, End Play, or native disposal. */
  setBeforeStop(ticket: GameSessionTicket, beforeStop: () => Promise<boolean>): boolean {
    if (!this.isCurrent(ticket) || !this.current!.stop || this.current!.stopping) return false;
    this.current!.beforeStop = beforeStop;
    return true;
  }

  acknowledgePaused(ticket: GameSessionTicket, paused: boolean): void {
    if (!this.isCurrent(ticket) || !["running", "paused"].includes(this.state.lifecycle)) return;
    const lifecycle = paused ? "paused" : "running";
    if (this.state.lifecycle !== lifecycle) this.publish({ ...this.state, lifecycle });
  }

  /** Failure cannot release an attached native owner without its release result. */
  fail(ticket: GameSessionTicket, error: unknown, quarantined = false): void {
    if (!this.owns(ticket)) return;
    const mustQuarantine = quarantined || Boolean(this.current!.stop);
    this.current!.abort.abort();
    this.publish({ ...this.state, lifecycle: "failure", quarantined: mustQuarantine,
      error: error instanceof Error ? error.message : String(error) });
  }

  stop(ticket: GameSessionTicket | undefined = this.current?.ticket): Promise<Result | undefined> {
    if (!ticket || !this.owns(ticket)) return Promise.resolve(undefined);
    const current = this.current!;
    if (current.stopping) return current.stopping;
    if (this.state.quarantined && !current.stop) return Promise.resolve(undefined);
    if (!current.stop && current.releaseBarrier) {
      current.stopping = current.releaseBarrier.then((release) => {
        this.completeRelease(ticket, release.quarantined);
        return undefined;
      });
      current.abort.abort();
      this.publish({ ...this.state, lifecycle: "stopping" });
      return current.stopping;
    }
    if (!current.stop) {
      this.current = null;
      current.abort.abort();
      this.publish({ ...this.state, mode: null, lifecycle: "idle", quarantined: false, error: null });
      return Promise.resolve(undefined);
    }
    const stopNative = (): Promise<Result | undefined> => {
      current.abort.abort();
      this.publish({ ...this.state, lifecycle: "stopping" });
      return Promise.resolve().then(current.stop!).then((result) => {
        const released = current.releaseBarrier
          ? Promise.all([current.releaseBarrier, result.released]).then((releases) => ({
              quarantined: releases.some((release) => release.quarantined),
            }))
          : result.released;
        void released.then(
          (release) => this.completeRelease(ticket, release.quarantined),
          (error: unknown) => this.fail(ticket, error, true),
        );
        return result;
      }, (error: unknown) => {
        // A failed stop does not establish that a native owner released anything.
        this.fail(ticket, error, true);
        return undefined;
      });
    };
    if (current.beforeStop && !ticket.signal.aborted) {
      this.publish({ ...this.state, lifecycle: "stopping", error: null });
      const refused = (error: unknown = null): undefined => {
        current.stopping = undefined;
        if (this.owns(ticket)) this.publish({ ...this.state, lifecycle: "retention-resolution",
          error: error === null ? null : error instanceof Error ? error.message : String(error) });
        return undefined;
      };
      current.stopping = Promise.resolve().then(current.beforeStop).then(
        (admitted) => admitted ? stopNative() : refused(),
        refused,
      );
    } else current.stopping = stopNative();
    return current.stopping;
  }

  private completeRelease(ticket: GameSessionTicket, quarantined: boolean): void {
    if (!this.owns(ticket)) return;
    if (quarantined) {
      this.fail(ticket, "Game resources did not confirm release. Reload the editor before starting another session.", true);
    } else {
      this.current = null;
      this.publish({ ...this.state, mode: null, lifecycle: "idle", quarantined: false, error: null });
    }
  }

  private publish(state: GameSessionState): void {
    this.state = Object.freeze(state);
    for (const listener of this.listeners) listener();
  }
}
