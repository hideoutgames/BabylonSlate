import { describe, expect, it, vi } from "vitest";
import { createFenceGpuBusyProbe, type FenceContext } from "./gpu-busy-probe";

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
  const gl = fakeGl();
  const probe = createFenceGpuBusyProbe(gl.gl, () => now);
  return { probe, gl, at: (t: number) => { now = t; } };
}

describe("GpuBusyProbe", () => {
  it("measures only Engine frames that rendered, so a frame cap's empty frames do not read as frames of no GPU time", () => {
    let now = 0;
    let rendered = false;
    const gl = fakeGl();
    const probe = createFenceGpuBusyProbe(gl.gl, () => now, () => rendered);
    probe.start();
    // An empty frame submits no fence; the rendered one after it is measured from its own submission.
    probe.frameEnd();
    expect(gl.flushes()).toBe(0);
    rendered = true;
    now = 10;
    probe.frameEnd();
    gl.signal(0);
    now = 40;
    probe.frameStart();
    expect(probe.stats()).toMatchObject({ frames: 1, medianMs: 30 });
  });

  it("does nothing until started", () => {
    const { probe, gl } = fixture();
    probe.frameEnd();
    probe.frameStart();
    expect(gl.flushes()).toBe(0);
    expect(probe.stats()).toBeNull();
  });

  it("reads its fences only as an Engine frame starts, with no timer of its own, timing a frame from its submission when the GPU was idle", () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const { probe, gl, at } = fixture();
    probe.start();
    at(100); probe.frameEnd();
    expect(gl.flushes()).toBe(1);
    // Done on the GPU at 105, but read when the next frame starts.
    gl.signal(0);
    at(112); probe.frameStart();
    expect(probe.stats()).toMatchObject({ frames: 1, medianMs: 12, p95Ms: 12 });
    expect(gl.deleted).toEqual([0]);
    expect(timers).not.toHaveBeenCalled();
    timers.mockRestore();
  });

  it("reads one completion per frame start while the GPU runs behind: a frame queued behind another reads from that one's completion", () => {
    const { probe, gl, at } = fixture();
    probe.start();
    at(0); probe.frameEnd();
    at(16); probe.frameStart(); probe.frameEnd();
    // The GPU finishes one frame per 16 ms period, each found as the next frame starts.
    gl.signal(0);
    at(32); probe.frameStart(); probe.frameEnd();
    gl.signal(1);
    at(48); probe.frameStart();
    expect(probe.stats()).toMatchObject({ frames: 2, medianMs: 24, pollMs: 16 });
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

  it("reports how often Engine frames started, the resolution of each frame's time", () => {
    const { probe, gl, at } = fixture();
    probe.start();
    at(0); probe.frameEnd();
    at(4); probe.frameStart();
    at(8); probe.frameStart();
    gl.signal(0);
    at(12); probe.frameStart();
    expect(probe.stats()!.pollMs).toBe(4);
  });

  it("counts the poll period from every frame start while active, even when every fence signalled before the next frame", () => {
    const { probe, gl, at } = fixture();
    probe.start();
    at(0); probe.frameEnd();
    gl.signal(0);
    at(16); probe.frameStart(); probe.frameEnd();
    gl.signal(1);
    at(32); probe.frameStart();
    expect(probe.stats()).toMatchObject({ frames: 2, pollMs: 16 });
  });

  it("does not count the gap across a restart toward the poll period", () => {
    const { probe, gl, at } = fixture();
    probe.start();
    at(10); probe.frameStart();
    probe.stop();
    probe.start();
    at(500); probe.frameStart(); probe.frameEnd();
    gl.signal(0);
    at(504); probe.frameStart();
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
