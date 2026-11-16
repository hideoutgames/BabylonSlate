import { describe, expect, it } from "vitest";
import {
  frameStageOf, GlSignatureRecorder, installGlSignature, RafCadence, SerialFrameProbe, ShadowFrameWindow, SYNTHETIC_RUNS,
  type ProbeFence, type SerialProbeHost,
} from "./gpu-frame-probe";

const FRAMEBUFFER = 0x8d40, READ_FRAMEBUFFER = 0x8ca8, DRAW_FRAMEBUFFER = 0x8ca9, SCISSOR_TEST = 0x0c11;
const COLOR_BIT = 0x4000, DEPTH_BIT = 0x0100, STENCIL_BIT = 0x0400;

describe("GL call signature", () => {
  const atlas = { name: "atlas" }, scene = { name: "scene" };
  /** A frame: one shadow tile cleared under a scissor and drawn, the scene target cleared and drawn, a blit to the backbuffer and a draw over it. */
  const frame = (recorder: GlSignatureRecorder, draws: { shadow: number; scene: number }, extraClear = false) => {
    recorder.beginFrame();
    recorder.bind(FRAMEBUFFER, atlas);
    recorder.viewport(0, 0, 2048, 2048);
    recorder.setCapability(SCISSOR_TEST, true);
    recorder.scissor(0, 0, 2048, 2048);
    recorder.clear(DEPTH_BIT);
    recorder.setCapability(SCISSOR_TEST, false);
    for (let index = 0; index < draws.shadow; index++) recorder.draw();
    recorder.bind(FRAMEBUFFER, scene);
    recorder.viewport(0, 0, 640, 360);
    recorder.clear(COLOR_BIT | DEPTH_BIT | STENCIL_BIT);
    if (extraClear) recorder.clear(DEPTH_BIT);
    for (let index = 0; index < draws.scene; index++) recorder.draw();
    recorder.bind(READ_FRAMEBUFFER, scene);
    recorder.bind(DRAW_FRAMEBUFFER, null);
    recorder.blit(1280, 720, COLOR_BIT);
    recorder.viewport(0, 0, 1280, 720);
    recorder.draw();
    return recorder.endFrame();
  };

  it("lists a frame's passes by draw framebuffer, with each clear's area and each blit's size, and counts its work", () => {
    const recorder = new GlSignatureRecorder();
    recorder.start();
    expect(frame(recorder, { shadow: 3, scene: 5 })).toMatchObject({
      passes: 3, clears: 2, blits: 1, draws: 9, invalidates: 0,
      // The tile under its scissor, then the scene target's viewport.
      texelsCleared: 2048 * 2048 + 640 * 360,
      // Each pass's viewports once: the tile, the scene target, and on the backbuffer the scene's and then its own.
      texelsCovered: 2048 * 2048 + 640 * 360 + 1280 * 720,
    });
    expect(recorder.stats()!.structures[0]!.passes).toEqual([
      "F1 v0,0,2048x2048 d@0,0,2048x2048 x3",
      "F2 v0,0,640x360 cds@0,0,640x360 x5",
      "D v0,0,1280x720 b1280x720c x1",
    ]);
  });

  it("hashes the pass structure without draw counts, so moving actors do not change it and one more clear does", () => {
    const recorder = new GlSignatureRecorder();
    recorder.start();
    const few = frame(recorder, { shadow: 1, scene: 2 })!.hash;
    const many = frame(recorder, { shadow: 40, scene: 300 })!.hash;
    const cleared = frame(recorder, { shadow: 1, scene: 2 }, true)!.hash;
    expect(many).toBe(few);
    expect(cleared).not.toBe(few);
    expect(recorder.lastHash).toBe(cleared);
  });

  it("starts no pass at a read framebuffer binding", () => {
    const recorder = new GlSignatureRecorder();
    recorder.start();
    recorder.beginFrame();
    recorder.bind(FRAMEBUFFER, scene);
    recorder.viewport(0, 0, 8, 8);
    recorder.draw();
    // A read-back's source: the draws after it still land on the scene target.
    recorder.bind(READ_FRAMEBUFFER, atlas);
    recorder.draw();
    expect(recorder.endFrame()).toMatchObject({ passes: 1, draws: 2 });
  });

  it("measures a clear by the scissor while the scissor test is on, else by the viewport", () => {
    const recorder = new GlSignatureRecorder();
    recorder.start();
    recorder.beginFrame();
    recorder.bind(FRAMEBUFFER, atlas);
    recorder.viewport(0, 0, 100, 100);
    recorder.scissor(10, 10, 20, 30);
    recorder.setCapability(SCISSOR_TEST, true);
    recorder.clear(DEPTH_BIT);
    recorder.setCapability(SCISSOR_TEST, false);
    recorder.clearBuffer(0x1800, 0);
    expect(recorder.endFrame()).toMatchObject({ clears: 2, texelsCleared: 20 * 30 + 100 * 100 });
    expect(recorder.stats()!.structures[0]!.passes).toEqual(["F1 v0,0,100x100 d@10,10,20x30 c0@0,0,100x100"]);
  });

  it("reports the window's most frequent structure, its share of the frames and each distinct one, with medians per frame", () => {
    const recorder = new GlSignatureRecorder();
    recorder.start();
    const usual = frame(recorder, { shadow: 1, scene: 10 })!.hash;
    frame(recorder, { shadow: 1, scene: 20 });
    const other = frame(recorder, { shadow: 1, scene: 30 }, true)!.hash;
    frame(recorder, { shadow: 1, scene: 40 });
    // A frame with no work is not one.
    recorder.beginFrame();
    expect(recorder.endFrame()).toBeNull();
    const stats = recorder.stats()!;
    expect(stats).toMatchObject({ frames: 4, modal: usual, modalShare: 0.75, distinct: 2, passes: 3, clears: 2, blits: 1, draws: 27 });
    expect(stats.structures.map((entry) => [entry.hash, entry.frames])).toEqual([[usual, 3], [other, 1]]);
    // A new window forgets the last.
    recorder.start();
    expect(recorder.stats()).toBeNull();
  });

  it("counts a fence only when the work after it goes on in the same pass", () => {
    const recorder = new GlSignatureRecorder();
    recorder.start();
    recorder.beginFrame();
    recorder.bind(FRAMEBUFFER, atlas);
    recorder.viewport(0, 0, 8, 8);
    recorder.draw();
    // Between two passes: free.
    recorder.fence();
    recorder.bind(FRAMEBUFFER, null);
    recorder.draw();
    expect(recorder.fenceSplits).toBe(0);
    // Inside the backbuffer's pass: it splits it.
    recorder.fence();
    recorder.draw();
    recorder.draw();
    expect(recorder.fenceSplits).toBe(1);
    recorder.endFrame();
  });

  it("wraps a context's calls while installed and hands the context's own back", () => {
    const calls: string[] = [];
    class Context {
      VIEWPORT = 1; SCISSOR_BOX = 2; DRAW_FRAMEBUFFER_BINDING = 3; SCISSOR_TEST = SCISSOR_TEST;
      getParameter(name: number) { return name === 1 ? new Int32Array([0, 0, 64, 32]) : name === 2 ? new Int32Array([0, 0, 64, 32]) : null; }
      isEnabled() { return false; }
      bindFramebuffer() { calls.push("bind"); }
      clear(mask: number) { calls.push(`clear ${mask}`); }
      drawElements() { calls.push("draw"); return 7; }
      blitFramebuffer() { calls.push("blit"); }
    }
    const gl = new Context();
    const recorder = new GlSignatureRecorder();
    recorder.start();
    const restore = installGlSignature(gl as unknown as WebGL2RenderingContext, recorder);
    recorder.beginFrame();
    gl.clear(DEPTH_BIT);
    // The context's own call still runs, with its result.
    expect(gl.drawElements()).toBe(7);
    (gl.blitFramebuffer as (...args: number[]) => void)(0, 0, 64, 32, 0, 0, 128, 64, COLOR_BIT);
    expect(recorder.endFrame()).toMatchObject({ passes: 1, clears: 1, draws: 1, blits: 1, texelsCleared: 64 * 32 });
    expect(recorder.stats()!.structures[0]!.passes).toEqual(["D v0,0,64x32 d@0,0,64x32 b128x64c x1"]);
    expect(calls).toEqual(["clear 256", "draw", "blit"]);
    restore();
    expect(Object.keys(gl).filter((key) => typeof (gl as unknown as Record<string, unknown>)[key] === "function")).toEqual([]);
    recorder.beginFrame();
    gl.clear(DEPTH_BIT);
    expect(recorder.endFrame()).toBeNull();
  });
});

describe("shadow frame window", () => {
  it("reports medians per frame, the maps kept as those held less those redrawn, and the atlas generation at both ends", () => {
    const window = new ShadowFrameWindow();
    window.start();
    const base = { maps: 6, continuous: 2, atlasEdge: 8192 };
    window.add({ ...base, redrawn: 2, tiles: 5, texels: 5 * 2048 ** 2, atlasGeneration: 1 });
    window.add({ ...base, redrawn: 6, tiles: 9, texels: 9 * 2048 ** 2, atlasGeneration: 2 });
    window.add({ ...base, redrawn: 2, tiles: 5, texels: 5 * 2048 ** 2, atlasGeneration: 2 });
    expect(window.stats()).toEqual({
      frames: 3, maps: 6, redrawn: 2, cached: 4, continuous: 2, tiles: 5, texels: 5 * 2048 ** 2, atlasEdge: 8192,
      generationFirst: 1, generationLast: 2,
    });
  });
});

describe("requestAnimationFrame cadence", () => {
  it("counts callbacks per second between the first and the last, and stops asking once stopped", () => {
    let now = 0;
    const queued: (() => void)[] = [];
    const cancelled: number[] = [];
    const cadence = new RafCadence((callback) => queued.push(callback), (handle) => cancelled.push(handle), () => now);
    cadence.start();
    for (let index = 0; index < 5; index++) {
      now += 10;
      queued.shift()!();
    }
    // Five callbacks span four intervals of 10 ms, from the start: 5 callbacks in 50 ms.
    expect(cadence.stats()).toEqual({ callbacks: 5, ms: 50, perSecond: 80 });
    cadence.stop();
    expect(cancelled).toHaveLength(1);
    queued.shift()!();
    expect(queued).toHaveLength(0);
  });
});

describe("frame stages", () => {
  it("groups draw passes into the stages a serialised frame is fenced after", () => {
    expect((["shadows", "captures", "mirrors", "probes", "objects", "water", "outlines", "geometry", "post", "layers", "tail"] as const).map(frameStageOf))
      .toEqual(["shadows", "captures", "captures", "captures", "main", "main", "main", "effects", "effects", "tail", "tail"]);
    expect((["cull", "readiness", "particles", "observers", "other"] as const).map(frameStageOf)).toEqual([null, null, null, null, null]);
  });
});

describe("serialised frame probe", () => {
  /** A GPU that finishes each fence when told, a clock and a queue of scheduled polls. */
  function fakeHost(options: { synthetic?: boolean } = {}) {
    let now = 0;
    const fences: { done: boolean; lost: boolean; disposed: boolean }[] = [];
    const polls: (() => void)[] = [];
    let drained = true;
    let syntheticReady = true;
    let syntheticDraws = 0;
    let hash = "aaaa0000";
    let splits = 0;
    const host: SerialProbeHost = {
      fence: (): ProbeFence => {
        const fence = { done: false, lost: false, disposed: false };
        fences.push(fence);
        return { done: () => fence.lost ? null : fence.done, dispose: () => { fence.disposed = true; } };
      },
      now: () => now,
      schedule: (callback) => { polls.push(callback); },
      drained: () => drained,
      synthetic: options.synthetic === false ? null : { ready: () => syntheticReady, draw: () => { syntheticDraws += 1; } },
      frameHash: () => hash,
      fenceSplits: () => splits,
    };
    return {
      host, fences, polls,
      advance: (ms: number) => { now += ms; },
      /** Runs the one queued poll. */
      poll: () => polls.shift()!(),
      finish: (...indices: number[]) => { for (const index of indices) fences[index]!.done = true; },
      setDrained: (value: boolean) => { drained = value; },
      setSyntheticReady: (value: boolean) => { syntheticReady = value; },
      syntheticDraws: () => syntheticDraws,
      setHash: (value: string) => { hash = value; },
      split: () => { splits += 1; },
    };
  }

  /**
   * One frame: shadows for `shadowsCpu` ms of submission, the main pass, then the tail. `gpu` gives each stage's GPU
   * time; the frame's task ends `taskMs` after its start. Returns once the frame's fences have all been seen.
   */
  function renderFrame(probe: SerialFrameProbe, gpu: ReturnType<typeof fakeHost>, timing: { shadows: number; main: number; tail: number }) {
    const first = gpu.fences.length;
    probe.frameStarted();
    probe.stageBoundary("shadows");
    gpu.advance(1);
    probe.stageBoundary("objects");
    gpu.advance(1);
    probe.stageBoundary("post");
    probe.stageBoundary("tail");
    // After the tail mark, later main or effects work is the tail's.
    probe.stageBoundary("post");
    probe.stageBoundary("layers");
    gpu.advance(1);
    probe.frameDrawn();
    probe.frameEnded();
    // Fences: start, "other" (before shadows), shadows, main, effects, tail. The task took 3 ms.
    gpu.finish(first, first + 1);
    // The first poll runs right after the frame's task.
    gpu.poll();
    let elapsed = 3;
    const until = (at: number, ...indices: number[]) => {
      gpu.advance(at - elapsed);
      elapsed = at;
      gpu.finish(...indices);
      gpu.poll();
    };
    until(1 + timing.shadows, first + 2);
    until(1 + timing.shadows + timing.main, first + 3, first + 4);
    until(1 + timing.shadows + timing.main + timing.tail, first + 5);
    return first;
  }

  it("holds rendering until the GPU has drained, then lets one frame render at a time", () => {
    const gpu = fakeHost();
    const probe = new SerialFrameProbe(gpu.host, 2);
    expect(probe.holding).toBe(false);
    expect(probe.request()).toBe(true);
    expect(probe.request()).toBe(false);
    expect(probe.holding).toBe(true);
    // The drain fence has not signalled.
    gpu.poll();
    expect(probe.holding).toBe(true);
    // Signalled, but the frame loop's own markers have not all finished.
    gpu.finish(0);
    gpu.setDrained(false);
    gpu.poll();
    expect(probe.holding).toBe(true);
    gpu.setDrained(true);
    gpu.poll();
    expect([probe.holding, probe.inFrame]).toEqual([false, false]);
    // No poll runs while it waits for the frame loop.
    expect(gpu.polls).toHaveLength(0);
    probe.frameStarted();
    expect([probe.holding, probe.inFrame]).toEqual([true, true]);
    probe.frameDrawn();
    probe.frameEnded();
    // Submitted and not finished: the next frame waits.
    gpu.poll();
    expect([probe.holding, probe.inFrame]).toEqual([true, false]);
    gpu.finish(1, 2);
    gpu.poll();
    expect(probe.holding).toBe(false);
    expect(gpu.fences.slice(0, 3).map((fence) => fence.disposed)).toEqual([true, true, true]);
  });

  it("times each stage from the later of its submission and the stage before, and the frame from its start to its last fence", () => {
    const gpu = fakeHost({ synthetic: false });
    const probe = new SerialFrameProbe(gpu.host, 3);
    probe.request();
    gpu.finish(0);
    gpu.poll();
    // The first frame is cold and left out of the medians.
    renderFrame(probe, gpu, { shadows: 30, main: 50, tail: 20 });
    renderFrame(probe, gpu, { shadows: 10, main: 6, tail: 4 });
    gpu.setHash("bbbb1111");
    renderFrame(probe, gpu, { shadows: 12, main: 8, tail: 2 });
    expect(probe.running).toBe(false);
    const result = probe.result()!;
    expect(result).toMatchObject({ id: 1, frames: 3, failed: null, splits: 0, coldMs: 101, frameMs: 22, cpuMs: 3, syntheticMs: null, syntheticColdMs: null });
    expect(result.hashes).toEqual(["aaaa0000", "aaaa0000", "bbbb1111"]);
    // Shadows were submitted 1 ms into the frame and finished 10 and 12 ms later; main and the effects stage before
    // the tail mark finished together, so the effects stage took no time of its own.
    expect(result.stages).toEqual([
      // Nothing was drawn before the shadows: done within the 3 ms task, so an upper bound.
      { stage: "other", ms: 3, censored: true },
      { stage: "shadows", ms: 11, censored: false },
      { stage: "main", ms: 7, censored: false },
      { stage: "effects", ms: 0, censored: false },
      { stage: "tail", ms: 3, censored: false },
    ]);
  });

  it("marks a stage that had finished by the frame's first poll as censored, an upper bound from its own submission", () => {
    const gpu = fakeHost({ synthetic: false });
    const probe = new SerialFrameProbe(gpu.host, 2);
    probe.request();
    gpu.finish(0);
    gpu.poll();
    for (let frame = 0; frame < 2; frame++) {
      const first = gpu.fences.length;
      probe.frameStarted();
      probe.stageBoundary("shadows");
      gpu.advance(2);
      probe.stageBoundary("objects");
      gpu.advance(6);
      probe.frameDrawn();
      probe.frameEnded();
      // The shadows finished while the main pass was still being submitted; first seen at the poll after the task.
      gpu.finish(first, first + 1, first + 2);
      gpu.advance(1);
      gpu.poll();
      gpu.advance(11);
      gpu.finish(first + 3);
      gpu.poll();
    }
    // Shadows: submitted at 2, seen done at 9, so at most 7 ms. Main: submitted at 8, done at 20.
    expect(probe.result()!.stages).toEqual([
      { stage: "other", ms: 9, censored: true },
      { stage: "shadows", ms: 7, censored: true },
      { stage: "main", ms: 12, censored: false },
    ]);
  });

  it("runs the synthetic load once the frames are measured, the first run cold, one fenced draw at a time", () => {
    const gpu = fakeHost();
    const probe = new SerialFrameProbe(gpu.host, 1);
    probe.request();
    gpu.finish(0);
    gpu.poll();
    probe.frameStarted();
    probe.frameDrawn();
    probe.frameEnded();
    gpu.finish(1, 2);
    gpu.setSyntheticReady(false);
    gpu.poll();
    // Its program still compiles: nothing is drawn, and rendering stays held.
    gpu.poll();
    expect([gpu.syntheticDraws(), probe.holding]).toEqual([0, true]);
    gpu.setSyntheticReady(true);
    const times = [9, 2, 2, 4, 2, 2];
    for (const ms of times) {
      gpu.poll();
      gpu.advance(ms);
      gpu.finish(gpu.fences.length - 1);
    }
    gpu.poll();
    expect(gpu.syntheticDraws()).toBe(SYNTHETIC_RUNS);
    expect(probe.running).toBe(false);
    expect(probe.result()).toMatchObject({ failed: null, syntheticColdMs: 9, syntheticMs: 2, frames: 1, frameMs: null });
  });

  it("does not measure a frame the view did not draw whole, and renders another", () => {
    const gpu = fakeHost({ synthetic: false });
    const probe = new SerialFrameProbe(gpu.host, 1);
    probe.request();
    gpu.finish(0);
    gpu.poll();
    probe.frameStarted();
    probe.frameEnded();
    gpu.finish(1, 2);
    gpu.poll();
    expect([probe.running, probe.holding]).toEqual([true, false]);
    probe.frameStarted();
    probe.frameDrawn();
    probe.frameEnded();
    gpu.finish(3, 4);
    gpu.poll();
    expect(probe.result()).toMatchObject({ frames: 1, failed: null });
  });

  it("gives up with what it measured when a fence never signals, when the view stops drawing, and on a lost context", () => {
    const stuck = fakeHost();
    const drain = new SerialFrameProbe(stuck.host, 1);
    drain.request();
    stuck.advance(3001);
    stuck.poll();
    expect([drain.running, drain.holding, drain.result()!.failed]).toEqual([false, false, "the GPU did not drain"]);
    expect(stuck.fences[0]!.disposed).toBe(true);

    const idle = fakeHost();
    const waiting = new SerialFrameProbe(idle.host, 2);
    waiting.request();
    idle.finish(0);
    idle.poll();
    idle.advance(4000);
    waiting.expire();
    expect(waiting.running).toBe(true);
    idle.advance(1001);
    waiting.expire();
    expect(waiting.result()).toMatchObject({ id: 1, frames: 0, failed: "the view drew too few frames" });

    const lost = fakeHost();
    const frame = new SerialFrameProbe(lost.host, 1);
    frame.request();
    lost.finish(0);
    lost.poll();
    frame.frameStarted();
    frame.frameDrawn();
    frame.frameEnded();
    lost.fences[1]!.lost = true;
    lost.poll();
    expect(frame.result()!.failed).toBe("lost context");
    // A second probe has a new id.
    frame.request();
    lost.advance(3001);
    lost.poll();
    expect(frame.result()!.id).toBe(2);
  });

  it("reports how many of its fences split a pass", () => {
    const gpu = fakeHost({ synthetic: false });
    gpu.split();
    const probe = new SerialFrameProbe(gpu.host, 1);
    probe.request();
    gpu.finish(0);
    gpu.poll();
    probe.frameStarted();
    gpu.split();
    gpu.split();
    probe.frameDrawn();
    probe.frameEnded();
    gpu.finish(1, 2);
    gpu.poll();
    // The split before the probe started is not its own.
    expect(probe.result()!.splits).toBe(2);
  });
});
