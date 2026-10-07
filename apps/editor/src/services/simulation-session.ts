import { createSessionSaveStorage, type SaveGameStorage } from "@babylonslate/core";
import type { OpenDocument } from "./document-service";
import type { GameSessionOwner, GameSessionTicket } from "./game-session-owner";
import type { PlaySessionResult } from "./play-session";
import type { SimulationViewport } from "./simulation-viewport";

type SimulationAuthoringSource = {
  lockAuthoringWrites(reason: string): { ready: Promise<boolean>; release(): void };
  lockAuthoring(reason: string): () => void;
  getOpenDocuments(): OpenDocument[];
};

/** Immutable authoring baseline and disposable session leases, never runtime edits. */
export class SimulationSession {
  private detached = false;
  private disposed = false;

  readonly ticket: GameSessionTicket;
  readonly viewport: SimulationViewport;
  readonly baseline: OpenDocument;
  readonly storage: ReturnType<typeof createSessionSaveStorage>;
  private readonly releaseAuthoring: () => void;

  private constructor(
    ticket: GameSessionTicket,
    viewport: SimulationViewport,
    baseline: OpenDocument,
    storage: ReturnType<typeof createSessionSaveStorage>,
    releaseAuthoring: () => void,
  ) {
    this.ticket = ticket;
    this.viewport = viewport;
    this.baseline = baseline;
    this.storage = storage;
    this.releaseAuthoring = releaseAuthoring;
  }

  static async prepare(options: {
    ticket: GameSessionTicket;
    viewport: SimulationViewport;
    source: SimulationAuthoringSource;
    backingStorage: SaveGameStorage;
  }): Promise<SimulationSession> {
    const { ticket, viewport, source } = options;
    ticket.signal.throwIfAborted();
    const writeLease = source.lockAuthoringWrites("Read-only during Simulation Play");
    let releaseDocuments: (() => void) | undefined;
    let acquired = false;
    const cancelAdmission = () => { if (!acquired) writeLease.release(); };
    ticket.signal.addEventListener("abort", cancelAdmission, { once: true });
    try {
      const ready = await writeLease.ready;
      ticket.signal.throwIfAborted();
      if (!ready) throw new Error("Simulation authoring protection was cancelled.");
      releaseDocuments = source.lockAuthoring("Read-only during Simulation Play");
      const baseline = source.getOpenDocuments().find((document) => document.id === viewport.documentId);
      if (!baseline || baseline.ref.kind !== "scene" || !baseline.content) throw new Error("The Simulation Scene was closed during preparation.");
      const storage = createSessionSaveStorage(options.backingStorage);
      const session = new SimulationSession(ticket, viewport, baseline, storage,
        () => { releaseDocuments?.(); writeLease.release(); });
      acquired = true;
      return session;
    } finally {
      ticket.signal.removeEventListener("abort", cancelAdmission);
      if (!acquired) { releaseDocuments?.(); writeLease.release(); }
    }
  }

  /** Detach through the existing viewport owner; cancellation still waits on release. */
  async suspendAuthoring(owner: GameSessionOwner<PlaySessionResult>): Promise<void> {
    this.ticket.signal.throwIfAborted();
    this.detached = true;
    const release = this.viewport.suspend();
    owner.holdRelease(this.ticket, release.then(() => ({ quarantined: false }), () => ({ quarantined: true })));
    try { await owner.awaitCurrent(this.ticket, release); }
    catch (error) {
      // Cancellation is handled by the outgoing release barrier, not quarantined
      // merely because the request is no longer current.
      if (!this.ticket.signal.aborted) owner.fail(this.ticket, error, true);
      throw error;
    }
  }

  dispose(restorePresentation: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    this.storage.dispose();
    this.releaseAuthoring();
    if (restorePresentation && this.detached) this.viewport.restore();
  }
}
