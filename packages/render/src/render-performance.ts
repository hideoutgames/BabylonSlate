/** Main-thread wall times may include driver waits. Copy latency may overlap
 * submission on the asynchronous RTT path; these are never additive CPU costs. */
export type RenderPerformanceSample = {
  frameId: number; tickId: number; sceneGeneration: number;
  completedAtMs: number;
  preparationMs: number; submissionMs: number; copyMs: number;
  drawCalls: number; width: number; height: number; resolutionScale: number;
  loading: boolean;
};
type Candidate = Omit<RenderPerformanceSample, "completedAtMs" | "copyMs">;
export type RenderPerformanceReceipt = { sample: Candidate; lease: number; completed: boolean };

/** View-owned, zero observer/GPU-query ownership. A receipt is admitted only
 * after the visible copy succeeds; asynchronous old views cannot publish into
 * a subsequent recording. The host owns the finite recording and mode policy. */
export class RenderPerformanceFeed {
  private listener: ((sample: RenderPerformanceSample) => void) | undefined;
  private lease = 0;
  private disposed = false;
  get active(): boolean { return this.listener !== undefined; }

  subscribe(listener: (sample: RenderPerformanceSample) => void): () => void {
    if (this.disposed) throw new Error("Render performance owner is disposed.");
    if (this.listener) throw new Error("A render performance subscription is already active.");
    const lease = ++this.lease;
    this.listener = listener;
    return () => { if (this.lease === lease) { this.listener = undefined; this.lease++; } };
  }
  begin(sample: Candidate): RenderPerformanceReceipt | null {
    return this.listener ? { sample, lease: this.lease, completed: false } : null;
  }
  complete(receipt: RenderPerformanceReceipt | null, copyMs: number, completedAtMs: number, sceneGeneration: number): void {
    if (!receipt || receipt.completed) return;
    receipt.completed = true;
    if (!this.listener || receipt.lease !== this.lease || receipt.sample.sceneGeneration !== sceneGeneration) return;
    try { this.listener({ ...receipt.sample, copyMs, completedAtMs }); }
    catch (error) {
      this.listener = undefined;
      this.lease++;
      console.warn("[render] Performance collection stopped after a consumer error.", error);
    }
  }
  dispose(): void { this.disposed = true; this.listener = undefined; this.lease++; }
}
