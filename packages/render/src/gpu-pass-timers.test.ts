import { describe, expect, it } from "vitest";
import { GpuPassTimers, type PassTimerHost } from "./gpu-pass-timers";

/** Timer queries as numbers: one active at a time, each query's ns set by the test once the "GPU" finished it. */
function fakeHost() {
  let next = 0;
  let active: number | null = null;
  const order: number[] = [];
  const results = new Map<number, number>();
  const state = { disjoint: false, refuse: false, now: 0, ends: 0, released: [] as number[] };
  const host: PassTimerHost<number> = {
    begin: () => {
      if (state.refuse) return null;
      if (active !== null) throw new Error("nested query");
      active = next++;
      order.push(active);
      return active;
    },
    end: () => {
      if (active === null) throw new Error("no query active");
      active = null;
      state.ends += 1;
    },
    read: (query) => results.get(query) ?? null,
    disjoint: () => {
      const value = state.disjoint;
      state.disjoint = false;
      return value;
    },
    release: (query) => state.released.push(query),
    now: () => state.now,
  };
  /** Finishes the queries begun so far, the nth taking `ms[n]` ms (in begin order, from the first unfinished one). */
  const finish = (...ms: number[]) => {
    const open = order.filter((query) => !results.has(query));
    ms.forEach((value, index) => results.set(open[index]!, value * 1e6));
  };
  return { host, state, finish, active: () => active };
}

/** One frame: shadows, the objects pass with a capture drawn in it, an effect, the tail's upscale and what follows the view. */
function frame(timers: GpuPassTimers<number>) {
  timers.frameBegin();
  timers.boundary("shadows", "Forward admitted shadows");
  timers.boundary("other", "other");
  timers.boundary("objects", "Forward objects");
  timers.boundary("captures", "captures");
  timers.boundary("objects", "Forward objects");
  timers.boundary("post", "Bloom");
  timers.boundary("tail", "Bloom");
  timers.boundary("post", "FSR upscale");
  timers.boundary("other", "after view");
  timers.frameEnd();
}

describe("GPU pass timers", () => {
  it("cuts a frame at every pass boundary, one query at a time, and sums a pass's segments by stage and label", () => {
    const { host, finish, active } = fakeHost();
    const timers = new GpuPassTimers(host);
    timers.start(true, 1);
    frame(timers);
    expect(active()).toBeNull();
    // frame start, shadows, other, objects, capture, objects again, bloom, upscale, after view: the same label twice in a
    // row (the tail mark) opens no new segment.
    finish(0.1, 1, 0.2, 3, 2, 1.5, 0.5, 0.75, 0.25);
    timers.frameBegin();
    const result = timers.result()!;
    expect(result.available).toBe(true);
    expect(result.frames).toBe(1);
    expect(result.frameMs).toBeCloseTo(9.3);
    const pass = (label: string) => result.passes.find((entry) => entry.label === label);
    expect(pass("Forward objects")).toMatchObject({ stage: "main", ms: 4.5 });
    expect(pass("captures")).toMatchObject({ stage: "captures", ms: 2 });
    expect(pass("Bloom")).toMatchObject({ stage: "effects", ms: 0.5 });
    // From the tail mark on, the effects chain's passes are the tail's, and so is what follows the view.
    expect(pass("FSR upscale")).toMatchObject({ stage: "tail", ms: 0.75 });
    expect(pass("after view")).toMatchObject({ stage: "tail", ms: 0.25 });
    // Work before the shadows and between passes: the frame start's and `other`'s, both stage `other` until a stage starts.
    expect(pass("frame start")).toMatchObject({ stage: "other", ms: 0.1 });
    expect(pass("other")).toMatchObject({ stage: "shadows", ms: 0.2 });
    expect(Object.fromEntries(result.stages.map((stage) => [stage.stage, stage.ms]))).toEqual({
      other: 0.1, shadows: 1.2, captures: 2, main: 4.5, effects: 0.5, tail: 1,
    });
    expect(result.passes.map((entry) => entry.label)).toEqual([
      "frame start", "Forward admitted shadows", "other", "Forward objects", "captures", "Bloom", "FSR upscale", "after view",
    ]);
  });

  it("reads a frame only once every query of it has finished, and takes medians and means over frames, a missing pass as zero", () => {
    const { host, finish } = fakeHost();
    const timers = new GpuPassTimers(host);
    timers.start(true, 3);
    const run = (withBloom: boolean) => {
      timers.frameBegin();
      timers.boundary("objects", "Forward objects");
      if (withBloom) timers.boundary("post", "Bloom");
      timers.frameEnd();
    };
    run(true);
    finish(0, 2);
    // The bloom query of the first frame has not finished: nothing is read.
    run(false);
    expect(timers.result()).toBeNull();
    finish(1, 0, 4);
    run(true);
    finish(0, 3, 1);
    timers.frameBegin();
    const result = timers.result()!;
    expect(result.frames).toBe(3);
    expect(result.passes.find((entry) => entry.label === "Forward objects")).toMatchObject({ ms: 3, meanMs: 3, frames: 3 });
    // Bloom ran in the first and third frames: median of 1, 0, 1, mean two thirds.
    const bloom = result.passes.find((entry) => entry.label === "Bloom")!;
    expect(bloom).toMatchObject({ ms: 1, frames: 2 });
    expect(bloom.meanMs).toBeCloseTo(2 / 3);
    expect(timers.running).toBe(false);
  });

  it("drops the frames in flight at a disjoint event and keeps measuring", () => {
    const { host, state, finish } = fakeHost();
    const timers = new GpuPassTimers(host);
    timers.start(true, 1);
    timers.frameBegin();
    timers.boundary("objects", "Forward objects");
    timers.frameEnd();
    finish(1, 50);
    state.disjoint = true;
    // The disjoint frame is dropped and the next one opens in its place.
    timers.frameBegin();
    timers.boundary("objects", "Forward objects");
    timers.frameEnd();
    finish(1, 5);
    timers.frameBegin();
    expect(timers.result()).toMatchObject({ frames: 1, discarded: 1, frameMs: 6 });
    expect(state.released).toEqual([0, 1, 2, 3]);
  });

  it("drops a frame whose query cannot start without ending a query it did not begin", () => {
    const { host, state, finish } = fakeHost();
    const timers = new GpuPassTimers(host);
    timers.start(true, 1);
    state.refuse = true;
    timers.frameBegin();
    timers.boundary("objects", "Forward objects");
    timers.frameEnd();
    expect(state.ends).toBe(0);
    state.refuse = false;
    timers.frameBegin();
    timers.frameEnd();
    finish(2);
    timers.frameBegin();
    expect(timers.result()).toMatchObject({ frames: 1, discarded: 1, frameMs: 2 });
  });

  it("reports timer queries absent at once where the context has none, and gives up on a view that stops drawing", () => {
    const { host, state } = fakeHost();
    const timers = new GpuPassTimers(host);
    timers.start(false);
    expect(timers.running).toBe(false);
    expect(timers.result()).toMatchObject({ id: 1, available: false, frames: 0, frameMs: null, failed: "no timer queries" });
    expect(timers.start(true, 2)).toBe(true);
    expect(timers.start(true, 2)).toBe(false);
    timers.frameBegin();
    timers.frameEnd();
    state.now = 21_000;
    timers.frameBegin();
    expect(timers.result()).toMatchObject({ id: 2, available: true, frames: 0, failed: "the view drew too few frames" });
  });

  it("gives each frame a GPU head start, outside every pass, and drops a frame whose head start ended before its submission did", () => {
    const { host, state, finish } = fakeHost();
    const draws: number[] = [];
    const timers = new GpuPassTimers({ ...host, headStart: (count) => draws.push(count) });
    timers.start(true, 1);
    const run = (cpuMs: number) => {
      timers.frameBegin();
      timers.boundary("objects", "Forward objects");
      state.now += cpuMs;
      timers.frameEnd();
    };
    // Head start 4 ms against 10 ms of submission: the GPU waited for the frame, which is dropped.
    run(10);
    finish(4, 0, 3);
    // The next frame gets a longer head start: 30 ms against 10 ms.
    run(10);
    expect(draws[1]).toBeGreaterThan(draws[0]!);
    finish(30, 0, 3);
    timers.frameBegin();
    expect(timers.result()).toMatchObject({ frames: 1, frameMs: 3, cpuMs: 10, headStart: { ms: 30, starved: 1 } });
    expect(timers.result()!.passes.map((entry) => entry.label)).toEqual(["frame start", "Forward objects"]);
  });
});
