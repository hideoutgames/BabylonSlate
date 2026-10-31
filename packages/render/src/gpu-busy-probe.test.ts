import { describe, expect, it } from "vitest";
import { createFenceGpuBusyProbe, createQueueGpuBusyProbe, type FenceContext } from "./gpu-busy-probe";

/** A WebGL2 fence API whose fences signal when the test says the GPU finished them. */
function fakeGl() {
  const signalled = new Set<number>();
  const failed = new Set<number>();
  const deleted: number[] = [];
  let next = 0;
  let flushes = 0;
  const gl: FenceContext = {
    SYNC_GPU_COMMANDS_COMPLETE: 1, ALREADY_SIGNALED: 2, CONDITION_SATISFIED: 3, WAIT_FAILED: 4,
    // Fence objects numbered from 0 in creation order.
    fenceSync: () => ({ id: next++ }) as unknown as WebGLSync,
    clientWaitSync: (sync) => {
      const id = (sync as unknown as { id: number }).id;
      if (failed.has(id)) return 4;
      return signalled.has(id) ? 2 : 0x911B; // TIMEOUT_EXPIRED
    },
    deleteSync: (sync) => { deleted.push((sync as unknown as { id: number }).id); },
    flush: () => { flushes++; },
  };
  return { gl, signal: (id: number) => signalled.add(id), fail: (id: number) => failed.add(id), deleted, flushes: () => flushes };
}

function fixture() {
  let now = 0;
  const pending: Array<() => void> = [];
  const gl = fakeGl();
  const probe = createFenceGpuBusyProbe(gl.gl, () => now, (callback) => pending.push(callback));
  // The polls queued so far only: an outstanding fence re-arms one.
  const runPolls = () => { for (const callback of pending.splice(0)) callback(); };
  return { probe, gl, at: (t: number) => { now = t; }, runPolls, pending };
}

describe("GpuBusyProbe", () => {
  it("does nothing until started", () => {
    const { probe, pending } = fixture();
    probe.frameEnd();
    expect(pending).toHaveLength(0);
    expect(probe.stats()).toBeNull();
  });

  it("times a frame from its submission when the GPU was idle, and flushes the fence at once", () => {
    const { probe, gl, at, runPolls } = fixture();
    probe.start();
    at(100); probe.frameEnd();
    expect(gl.flushes()).toBe(1);
    at(104); runPolls();
    expect(probe.stats()).toBeNull();
    gl.signal(0);
    at(112); probe.poll();
    expect(probe.stats()).toMatchObject({ frames: 1, medianMs: 12, p95Ms: 12 });
    expect(gl.deleted).toEqual([0]);
  });

  it("starts a frame queued behind a busy GPU at the previous frame's completion, not at its own submission", () => {
    const { probe, gl, at } = fixture();
    probe.start();
    at(0); probe.frameEnd();
    at(5); probe.frameEnd();
    gl.signal(0);
    at(20); probe.poll();
    gl.signal(1);
    at(35); probe.poll();
    // 20 ms for the first frame (0→20) and 15 ms for the second (20→35), not 30 ms from its own submission.
    expect(probe.stats()).toMatchObject({ frames: 2, medianMs: 17.5 });
  });

  it("measures in submission order, so a later fence never completes before an earlier one", () => {
    const { probe, gl, at } = fixture();
    probe.start();
    at(0); probe.frameEnd();
    at(1); probe.frameEnd();
    gl.signal(1);
    at(10); probe.poll();
    expect(probe.stats()).toBeNull();
    gl.signal(0);
    at(12); probe.poll();
    expect(probe.stats()!.frames).toBe(2);
  });

  it("skips frames past its bound of outstanding fences instead of queueing them", () => {
    const { probe, gl } = fixture();
    probe.start();
    for (let frame = 0; frame < 10; frame++) probe.frameEnd();
    expect(gl.flushes()).toBe(6);
    for (let id = 0; id < 6; id++) gl.signal(id);
    probe.poll();
    expect(probe.stats()).toMatchObject({ frames: 6, skipped: 4 });
  });

  it("measures nothing for a fence whose wait failed (a lost context)", () => {
    const { probe, gl, at } = fixture();
    probe.start();
    at(0); probe.frameEnd();
    gl.fail(0);
    at(5); probe.poll();
    expect(probe.stats()).toBeNull();
    expect(gl.deleted).toEqual([0]);
  });

  it("reports how often it polled, the resolution of each frame's time", () => {
    const { probe, gl, at } = fixture();
    probe.start();
    at(0); probe.frameEnd();
    at(4); probe.poll();
    at(8); probe.poll();
    gl.signal(0);
    at(12); probe.poll();
    expect(probe.stats()!.pollMs).toBe(4);
  });

  it("restarts from nothing, and keeps its results readable once stopped", () => {
    const { probe, gl, at } = fixture();
    probe.start();
    at(0); probe.frameEnd();
    gl.signal(0);
    at(10); probe.poll();
    probe.stop();
    probe.frameEnd();
    expect(probe.stats()!.frames).toBe(1);
    probe.start();
    expect(probe.stats()).toBeNull();
  });
});

describe("WebGPU queue probe", () => {
  it("times each frame from its submission to the queue draining", async () => {
    let now = 0;
    let finish: (() => void) | null = null;
    const queue = { onSubmittedWorkDone: () => new Promise<void>((resolve) => { finish = resolve; }) };
    const probe = createQueueGpuBusyProbe(queue, () => now);
    probe.start();
    now = 10; probe.frameEnd();
    now = 24; finish!();
    await Promise.resolve();
    await Promise.resolve();
    expect(probe.stats()).toMatchObject({ frames: 1, medianMs: 14 });
  });
});
