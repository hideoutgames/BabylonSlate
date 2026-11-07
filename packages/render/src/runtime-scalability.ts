import { qualityValuesKey, type ScalabilityAcknowledgement, type ScalabilityTransaction } from "@haptic/core";

class SupersededSettings extends Error {}
export interface RuntimeScalabilityHost {
  apply(transaction: ScalabilityTransaction): void;
  prepare(assertCurrent: () => void): Promise<void>;
  read(transaction: ScalabilityTransaction): ScalabilityAcknowledgement;
  publish(ack: ScalabilityAcknowledgement): void;
  invalidate(): void;
  retainResources?(): () => void;
}
/**
 * Whether `next` draws what `applied` draws: equal render settings but for level labels. The frame cap is pacing, not
 * drawing. Such a transaction (a `quality reset` that resets nothing the view draws) needs no preparation.
 */
function drawsAlike(next: ScalabilityTransaction, applied: ScalabilityTransaction): boolean {
  return qualityValuesKey(next.settings.render) === qualityValuesKey(applied.settings.render);
}
/** View-owned queue. Only the existing frame scheduler calls advance/presented. */
export class RuntimeScalability {
  private queued: ScalabilityTransaction | undefined;
  private active: { transaction: ScalabilityTransaction; ready: boolean; rollback: boolean } | undefined;
  private committed: ScalabilityTransaction;
  /** The last transaction given to the host; `committed` itself once nothing is in flight. */
  private applied: ScalabilityTransaction;
  /** `committed` changed without a preparation; it is acknowledged at the next presented frame. */
  private unacknowledged = false;
  private disposed = false;
  private latestRevision = 0;
  private rollback = false;
  private initialPresented = false;
  private restorationFailed = false;
  private releaseRetained: (() => void) | undefined;
  private readonly host: RuntimeScalabilityHost;
  constructor(initial: ScalabilityTransaction, host: RuntimeScalabilityHost) {
    this.host = host;
    this.committed = this.applied = structuredClone(initial);
    this.latestRevision = initial.revision;
  }
  enqueue(transaction: ScalabilityTransaction): void {
    if (this.disposed || transaction.revision <= this.latestRevision) return;
    this.latestRevision = transaction.revision;
    this.restorationFailed = false;
    if (this.active?.ready) this.active = undefined;
    this.queued = structuredClone(transaction);
    this.host.invalidate();
  }
  get canPresent(): boolean { return !this.restorationFailed && !this.queued && !this.rollback && (!this.active || this.active.ready); }
  /**
   * Whether the next ready presented frame confirms something (`presented`): a prepared transaction, the first
   * frame, or settings applied without preparation. A view probes readiness after presenting only while this holds.
   */
  get awaitsPresentation(): boolean {
    if (this.disposed || !this.canPresent) return false;
    return this.active?.ready === true || (!this.active && (!this.initialPresented || this.unacknowledged));
  }
  /** Safe boundary before this view's framebuffer is resized or copied. */
  advance(): void {
    if (this.disposed || this.active || this.restorationFailed) return;
    const transaction = this.queued ?? (this.rollback ? this.committed : undefined);
    if (!transaction) return;
    const rollback = !this.queued;
    this.queued = undefined;
    this.rollback = false;
    if (!rollback && this.initialPresented && this.applied === this.committed && drawsAlike(transaction, this.committed)) {
      // Nothing to prepare, retain or hold: the host takes the new labels and pacing, and the view keeps drawing.
      try {
        this.host.apply(transaction);
        this.applied = this.committed = transaction;
        this.unacknowledged = true;
      } catch (error) {
        this.rollback = true;
        this.host.publish({ revision: transaction.revision, status: "failed", message: error instanceof Error ? error.message : String(error) });
      }
      this.host.invalidate();
      return;
    }
    const active = { transaction, ready: false, rollback };
    this.active = active;
    const assertCurrent = () => {
      if (this.disposed || this.active !== active || this.queued) throw new SupersededSettings();
    };
    const failed = (error: unknown) => {
      if (this.disposed || this.active !== active) return;
      this.active = undefined;
      if (!(error instanceof SupersededSettings)) {
        if (!rollback) {
          this.rollback = true;
          this.host.publish({ revision: transaction.revision, status: "failed", message: error instanceof Error ? error.message : String(error) });
        } else {
          // A restoration failure must not present partly prepared resources.
          this.restorationFailed = true;
          this.host.publish({ revision: this.latestRevision, status: "failed", message: `Restoring rendering settings failed: ${String(error)}` });
        }
      }
      this.host.invalidate();
    };
    try {
      this.releaseRetained ??= this.host.retainResources?.();
      this.applied = transaction;
      this.host.apply(transaction);
      void this.host.prepare(assertCurrent).then(() => {
        assertCurrent();
        active.ready = true;
        this.host.invalidate();
      }).catch(failed);
    } catch (error) { failed(error); }
  }
  /** Called after the existing view has presented a ready frame. */
  presented(): void {
    if (!this.awaitsPresentation) return;
    const active = this.active;
    if (active?.ready) {
      this.active = undefined;
      this.releaseRetained?.();
      this.releaseRetained = undefined;
      if (!active.rollback) {
        this.committed = active.transaction;
        this.initialPresented = true;
        this.unacknowledged = false;
        this.host.publish(this.host.read(this.committed));
      }
    } else {
      this.initialPresented = true;
      this.unacknowledged = false;
      this.host.publish(this.host.read(this.committed));
    }
  }
  dispose(): void {
    this.disposed = true; this.queued = this.active = undefined;
    this.releaseRetained?.(); this.releaseRetained = undefined;
  }
}
