import type { ScalabilityAcknowledgement, ScalabilityTransaction } from "@babylonslate/core";

class SupersededSettings extends Error {}
export interface RuntimeScalabilityHost {
  apply(transaction: ScalabilityTransaction): void;
  prepare(assertCurrent: () => void): Promise<void>;
  read(transaction: ScalabilityTransaction): ScalabilityAcknowledgement;
  publish(ack: ScalabilityAcknowledgement): void;
  invalidate(): void;
  retainResources?(): () => void;
}
/** View-owned queue. Only the existing frame scheduler calls advance/presented. */
export class RuntimeScalability {
  private queued: ScalabilityTransaction | undefined;
  private active: { transaction: ScalabilityTransaction; ready: boolean; rollback: boolean } | undefined;
  private committed: ScalabilityTransaction;
  private disposed = false;
  private latestRevision = 0;
  private rollback = false;
  private initialPresented = false;
  private restorationFailed = false;
  private releaseRetained: (() => void) | undefined;
  private readonly host: RuntimeScalabilityHost;
  constructor(initial: ScalabilityTransaction, host: RuntimeScalabilityHost) {
    this.host = host;
    this.committed = structuredClone(initial);
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
  /** Safe boundary before this view's framebuffer is resized or copied. */
  advance(): void {
    if (this.disposed || this.active || this.restorationFailed) return;
    const transaction = this.queued ?? (this.rollback ? this.committed : undefined);
    if (!transaction) return;
    const rollback = !this.queued;
    this.queued = undefined;
    this.rollback = false;
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
    if (this.disposed || !this.canPresent) return;
    const active = this.active;
    if (active?.ready) {
      this.active = undefined;
      this.releaseRetained?.();
      this.releaseRetained = undefined;
      if (!active.rollback) {
        this.committed = active.transaction;
        this.initialPresented = true;
        this.host.publish(this.host.read(this.committed));
      }
    } else if (!this.initialPresented) {
      this.initialPresented = true;
      this.host.publish(this.host.read(this.committed));
    }
  }
  dispose(): void {
    this.disposed = true; this.queued = this.active = undefined;
    this.releaseRetained?.(); this.releaseRetained = undefined;
  }
}
