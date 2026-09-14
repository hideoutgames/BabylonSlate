import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core";
import {
  beginManagedRenderAllocation,
  limitManagedRenderBytes,
  managedRenderReservations,
  releaseManagedRenderLeaseAfterDisposal,
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
