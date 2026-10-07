/** Game lifetime is independent of the canvas or React surface presenting it. */
export type GameSessionMode = "play" | "simulate" | "preview";
export type GameSessionLifecycle = "idle" | "preparing" | "running" | "stopping" | "failure";

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

  attach(ticket: GameSessionTicket, stop: () => Result | Promise<Result>): boolean {
    if (!this.isCurrent(ticket) || this.state.lifecycle !== "preparing") return false;
    this.current!.stop = stop;
    this.publish({ ...this.state, lifecycle: "running" });
    return true;
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
    if (!current.stop) {
      this.current = null;
      current.abort.abort();
      this.publish({ ...this.state, mode: null, lifecycle: "idle", error: null });
      return Promise.resolve(undefined);
    }
    current.stopping = Promise.resolve().then(current.stop).then((result) => {
      void result.released.then((release) => {
        if (!this.owns(ticket)) return;
        if (release.quarantined) {
          this.fail(ticket, "Game resources did not confirm release. Reload the editor before starting another session.", true);
        } else {
          this.current = null;
          this.publish({ ...this.state, mode: null, lifecycle: "idle", error: null });
        }
      }, (error: unknown) => this.fail(ticket, error, true));
      return result;
    }, (error: unknown) => {
      // A failed stop does not establish that a native owner released anything.
      this.fail(ticket, error, true);
      return undefined;
    });
    current.abort.abort();
    this.publish({ ...this.state, lifecycle: "stopping" });
    return current.stopping;
  }

  private publish(state: GameSessionState): void {
    this.state = Object.freeze(state);
    for (const listener of this.listeners) listener();
  }
}
