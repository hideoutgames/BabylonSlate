import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import {
  beginManagedRenderAllocation,
  limitManagedRenderBytes,
  managedRenderReservations,
  releaseManagedRenderLeaseAfterDisposal,
  reserveManagedShadowBytes,
} from "./managed-render-resources";
const engines: NullEngine[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});
function fixture(webgpu = true) {
  const engine = new NullEngine();
  engines.push(engine);
  Object.defineProperty(engine, "isWebGPU", { value: webgpu });
  limitManagedRenderBytes(engine, 64);
  const lease = beginManagedRenderAllocation(engine, 32)!;
  lease.commit([{ handle: {}, bytes: 32, category: "postprocess" }]);
  return { engine, lease };
}
function limitedEngine(bytes: number) {
  const engine = new NullEngine();
  engines.push(engine);
  limitManagedRenderBytes(engine, bytes);
  return engine;
}
describe("managed render allocation transactions", () => {
  it("holds old and new generations before allocation, rolls back, and deduplicates borrowed handles", () => {
    const engine = limitedEngine(100);
    const shadowOwner = {};
    reserveManagedShadowBytes(engine, shadowOwner, 20);
    const first = beginManagedRenderAllocation(engine, 30)!;
    const texture = {};
    first.commit([
      { handle: texture, bytes: 30, category: "sceneColor" },
      { handle: texture, bytes: 30, category: "sceneColor" },
    ]);
    const next = beginManagedRenderAllocation(engine, 50)!;
    expect(managedRenderReservations(engine).reservedBytes).toBe(100);
    expect(beginManagedRenderAllocation(engine, 1)).toBeUndefined();
    next.release();
    expect(managedRenderReservations(engine).reservedBytes).toBe(50);
    const borrower = beginManagedRenderAllocation(engine, 30)!;
    borrower.commit([{ handle: texture, bytes: 30, category: "sceneColor" }]);
    expect(managedRenderReservations(engine).categoryBytes.sceneColor).toBe(30);
    first.release();
    first.release();
    expect(managedRenderReservations(engine).reservedBytes).toBe(50);
    borrower.release();
    expect(managedRenderReservations(engine).reservedBytes).toBe(20);
    reserveManagedShadowBytes(engine, shadowOwner, 0);
    expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  });
  it("keeps an underestimated candidate reserved until caller confirms cleanup", () => {
    const engine = limitedEngine(50);
    const candidate = beginManagedRenderAllocation(engine, 40)!;
    expect(() =>
      candidate.commit([{ handle: {}, bytes: 41, category: "sceneColor" }]),
    ).toThrow(/reserved peak/);
    expect(beginManagedRenderAllocation(engine, 11)).toBeUndefined();
    expect(managedRenderReservations(engine).pendingBytes).toBe(40);
    candidate.release();
    expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  });
});
describe("managed render disposal completion", () => {
  it("holds WebGPU replacement overlap until a natural end-frame drain without forcing sibling draws", async () => {
    const { engine, lease } = fixture();
    const frame = vi.spyOn(engine, "endFrame");
    const released = releaseManagedRenderLeaseAfterDisposal(engine, lease);
    expect(releaseManagedRenderLeaseAfterDisposal(engine, lease)).toBe(
      released,
    );
    const replacement = beginManagedRenderAllocation(engine, 32)!;
    expect(beginManagedRenderAllocation(engine, 1)).toBeUndefined();
    await Promise.resolve();
    expect(frame).not.toHaveBeenCalled();
    expect(managedRenderReservations(engine).reservedBytes).toBe(64);
    engine.endFrame();
    await released;
    expect(managedRenderReservations(engine).reservedBytes).toBe(32);
    replacement.release();
  });
  it("does not release disposal queued inside an end-frame observer in the same notification", async () => {
    const { engine, lease } = fixture();
    let completion: Promise<void> | undefined;
    engine.onEndFrameObservable.addOnce(() => {
      completion = releaseManagedRenderLeaseAfterDisposal(engine, lease);
    });
    engine.endFrame();
    expect(managedRenderReservations(engine).reservedBytes).toBe(32);
    await Promise.resolve();
    expect(managedRenderReservations(engine).reservedBytes).toBe(32);
    engine.endFrame();
    await completion;
    expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  });
  it("settles through confirmed Engine disposal while paused and removes its pending frame observer", async () => {
    const { engine, lease } = fixture();
    const framesBefore = engine.onEndFrameObservable.observers.length;
    const completion = releaseManagedRenderLeaseAfterDisposal(engine, lease);
    await Promise.resolve();
    expect(engine.onEndFrameObservable.observers.length).toBe(framesBefore + 1);
    engine.dispose();
    await completion;
    expect(engine.onEndFrameObservable.observers.length).toBe(0);
    await releaseManagedRenderLeaseAfterDisposal(engine, lease);
  });
  it("settles without a frame when the Engine's context was already lost", async () => {
    const { engine, lease } = fixture();
    // A lost WebGPU Engine never draws another frame or restores its device.
    (engine as unknown as { _contextWasLost: boolean })._contextWasLost = true;
    await releaseManagedRenderLeaseAfterDisposal(engine, lease);
    expect(managedRenderReservations(engine).reservedBytes).toBe(0);
  });
  it("settles a pending release when the Engine's context is lost and removes its frame observer", async () => {
    const { engine, lease } = fixture();
    const framesBefore = engine.onEndFrameObservable.observers.length;
    const completion = releaseManagedRenderLeaseAfterDisposal(engine, lease);
    await Promise.resolve();
    expect(managedRenderReservations(engine).reservedBytes).toBe(32);
    (engine as unknown as { _contextWasLost: boolean })._contextWasLost = true;
    engine.onContextLostObservable.notifyObservers(engine);
    await completion;
    expect(managedRenderReservations(engine).reservedBytes).toBe(0);
    // Babylon's Observable.remove unregisters on the next macrotask.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.onEndFrameObservable.observers.length).toBe(framesBefore);
  });
  it("releases synchronously on WebGL and rejects another Engine's lease", async () => {
    const first = fixture(false);
    const second = fixture();
    expect(() =>
      releaseManagedRenderLeaseAfterDisposal(second.engine, first.lease),
    ).toThrow(/another Engine/);
    expect(managedRenderReservations(first.engine).reservedBytes).toBe(32);
    const completion = releaseManagedRenderLeaseAfterDisposal(
      first.engine,
      first.lease,
    );
    expect(managedRenderReservations(first.engine).reservedBytes).toBe(0);
    await completion;
    second.lease.release();
  });
});
