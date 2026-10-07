import { createSessionSaveStorage, type SaveGameStorage, type SerializedScene } from "@babylonslate/core";
import type { OpenDocument } from "./document-service";
import type { SimulationSceneCaptureResult } from "@babylonslate/runtime";
import type { SimulationDocumentTransaction } from "./simulation-document";
import type { GameSessionOwner, GameSessionTicket } from "./game-session-owner";
import type { PlaySessionResult } from "./play-session";
import type { SimulationViewport } from "./simulation-viewport";

type SimulationAuthoringSource = {
  lockAuthoringWrites(reason: string): { ready: Promise<boolean>; release(): void };
  beginSimulationDocument(id: string): SimulationDocumentTransaction;
};

export interface SimulationRetentionState {
  readonly status: "inactive" | "capturing" | "failed" | "applied" | "discarded";
  readonly reason: string | null;
}

/** Immutable authoring baseline and disposable session leases, never runtime edits. */
export class SimulationSession {
  private detached = false;
  private disposed = false;
  private retention: SimulationRetentionState = Object.freeze({ status: "inactive", reason: null });
  private readonly listeners = new Set<() => void>();
  private pendingStop: Promise<boolean> | null = null;
  private captured: Extract<SimulationSceneCaptureResult, { ok: true }> | null = null;
  private discardRequested = false;
  private readonly discardWaiters = new Set<() => void>();
  private readonly document: SimulationDocumentTransaction;
  readonly keepChanges: boolean;
  readonly retentionUnavailableReason: string | null;
  readonly getRetention = (): SimulationRetentionState => this.retention;
  readonly subscribeRetention = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };

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
    document: SimulationDocumentTransaction,
    keepChanges: boolean,
  ) {
    this.ticket = ticket;
    this.viewport = viewport;
    this.baseline = baseline;
    this.storage = storage;
    this.releaseAuthoring = releaseAuthoring;
    this.document = document;
    this.keepChanges = keepChanges;
    const scene = baseline.content as SerializedScene;
    this.retentionUnavailableReason = scene.settings.sceneLayers.some(entry => entry.enabled)
      ? "Keep is unavailable for independent SceneLayer startup instances. Discard this session to leave authored data unchanged."
      : scene.actors.some(actor => actor.components.some(component => component.classId === "SceneStreamingComponent" && (component.properties.sceneGuid || component.properties.sceneName)))
        ? "Keep is unavailable for independent streamed Scene instances. Discard this session to leave authored data unchanged."
        : scene.actors.some(actor => actor.components.some(component => component.classId === "DynamicRuntimeMeshComponent"))
          ? "Keep is unavailable for Dynamic Runtime Mesh geometry without an authored resource representation."
          : null;
  }

  static async prepare(options: {
    ticket: GameSessionTicket;
    viewport: SimulationViewport;
    source: SimulationAuthoringSource;
    backingStorage: SaveGameStorage;
    keepChanges?: boolean;
  }): Promise<SimulationSession> {
    const { ticket, viewport, source } = options;
    ticket.signal.throwIfAborted();
    const writeLease = source.lockAuthoringWrites("Read-only during Simulation Play");
    let document: SimulationDocumentTransaction | undefined;
    let acquired = false;
    const cancelAdmission = () => { if (!acquired) writeLease.release(); };
    ticket.signal.addEventListener("abort", cancelAdmission, { once: true });
    try {
      const ready = await writeLease.ready;
      ticket.signal.throwIfAborted();
      if (!ready) throw new Error("Simulation authoring protection was cancelled.");
      document = source.beginSimulationDocument(viewport.documentId);
      const baseline = document.baseline;
      const storage = createSessionSaveStorage(options.backingStorage);
      const session = new SimulationSession(ticket, viewport, baseline, storage,
        () => { document?.release(); writeLease.release(); }, document, options.keepChanges === true);
      acquired = true;
      return session;
    } finally {
      ticket.signal.removeEventListener("abort", cancelAdmission);
      if (!acquired) { document?.release(); writeLease.release(); }
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

  /** Installed as the session owner's before-Stop gate, before any destructive cleanup. */
  resolveStop(capture: () => Promise<SimulationSceneCaptureResult>): Promise<boolean> {
    if (this.pendingStop) return this.pendingStop;
    if (!this.keepChanges || this.discardRequested || this.retention.status === "applied") return Promise.resolve(true);
    if (this.disposed) return Promise.resolve(false);
    if (this.retentionUnavailableReason) { this.publishRetention("failed", this.retentionUnavailableReason); return Promise.resolve(false); }
    this.publishRetention("capturing", null);
    const attempt = (async () => {
      try {
        const result = this.captured ?? await capture();
        if (this.discardRequested) return true;
        if (!result.ok) { this.publishRetention("failed", `${result.path}: ${result.reason}`); return false; }
        if (result.identity.generation !== this.ticket.generation) {
          this.publishRetention("failed", "The final scene belongs to a different Simulation session."); return false;
        }
        // Retain only one bounded complete candidate for permission/budget retries.
        this.captured = result;
        const applied = await this.document.applyScene(result.scene);
        if (!applied.ok) { this.publishRetention("failed", applied.reason); return false; }
        this.publishRetention("applied", null); this.captured = null;
        return true;
      } catch (error) {
        if (this.discardRequested) return true;
        this.publishRetention("failed", error instanceof Error ? error.message : "Simulation changes could not be retained.");
        return false;
      }
    })();
    let discard!: () => void;
    const discarded = new Promise<boolean>(resolve => { discard = () => resolve(true); this.discardWaiters.add(discard); });
    this.pendingStop = Promise.race([attempt, discarded]).finally(() => {
      this.discardWaiters.delete(discard); this.pendingStop = null;
    });
    return this.pendingStop;
  }

  /** Explicit user discard, or inaccessible host teardown, never applies a subset. */
  discardChanges(reason: string | null = null): void {
    this.discardRequested = true; this.captured = null;
    for (const resolve of this.discardWaiters) resolve();
    this.publishRetention("discarded", reason);
  }

  private publishRetention(status: SimulationRetentionState["status"], reason: string | null): void {
    this.retention = Object.freeze({ status, reason });
    for (const listener of this.listeners) listener();
  }

  dispose(restorePresentation: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    this.captured = null;
    this.listeners.clear();
    this.storage.dispose();
    this.releaseAuthoring();
    if (restorePresentation && this.detached) this.viewport.restore();
  }
}
