import { NullEngine } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireEngineGpuTiming, observeEngineGpuTiming, readEngineGpuTiming, type EngineGpuTimingSample } from "./engine-gpu-timing";

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); vi.restoreAllMocks(); });
function fixture() {
  const engine = new NullEngine(); engines.push(engine);
  const caps = engine.getCaps();
  vi.spyOn(engine, "getCaps").mockReturnValue({ ...caps, timerQuery: {} as NonNullable<typeof caps.timerQuery> });
  const capture = vi.spyOn(engine, "captureGPUFrameTime");
  const counter = engine.getGPUFrameTimeCounter();
  const deliver = () => engine.onEndFrameObservable.notifyObservers(engine);
  const ready = (ns: number) => { counter.fetchNewFrame(); counter.addCount(ns, true); deliver(); };
  return { engine, capture, counter, deliver, ready };
}

describe("shared GPU timing ownership", () => {
  it("shares renderer/profiler capture and restores the prior switch on the final release", () => {
    const { engine, capture } = fixture();
    const renderer = acquireEngineGpuTiming(engine)!;
    const profile = observeEngineGpuTiming(engine, () => {});
    expect(capture.mock.calls).toEqual([[true]]);
    expect(engine.onBeginFrameObservable.hasObservers()).toBe(true);
    profile.release(); profile.release();
    expect(capture.mock.calls).toEqual([[true]]);
    renderer.release(); renderer.release();
    expect(capture.mock.calls).toEqual([[true], [false]]);
    expect(engine.onBeginFrameObservable.hasObservers()).toBe(false);
    expect(engine.onEndFrameObservable.hasObservers()).toBe(false);
    expect(engine.onContextLostObservable.hasObservers()).toBe(false);
    expect(engine.onContextRestoredObservable.hasObservers()).toBe(false);
  });

  it("does not disable capture that was already owned outside the coordinator", () => {
    const { engine, capture } = fixture();
    engine.captureGPUFrameTime(true);
    capture.mockClear();
    const profile = observeEngineGpuTiming(engine, () => {});
    profile.release();
    expect(capture.mock.calls).toEqual([[true], [true]]);
    expect(engine.onBeginFrameObservable.hasObservers()).toBe(true);
    engine.captureGPUFrameTime(false);
  });

  it("delivers only fresh valid queries in milliseconds, without pretending frame alignment", () => {
    const { engine, counter, ready, deliver } = fixture();
    ready(99_000_000); // An older cached result is never reused.
    const samples: EngineGpuTimingSample[] = [];
    const profile = observeEngineGpuTiming(engine, sample => samples.push(sample), { now: () => 123 });
    deliver(); // Pending/disjoint queries do not advance Babylon's count.
    ready(88_000_000); // May be an inherited native token: discard first ready result.
    expect(samples).toEqual([]);
    ready(2_500_000);
    deliver(); deliver();
    expect(samples).toEqual([{ observedAtMs: 123, durationMs: 2.5, querySequence: 3, coalescedQueries: 0, attribution: "engine-aggregate" }]);
    ready(Number.NaN); ready(-1);
    expect(samples).toHaveLength(1);
    counter.fetchNewFrame(); counter.addCount(3_000_000, true);
    ready(4_000_000);
    expect(samples.at(-1)).toMatchObject({ durationMs: 4, coalescedQueries: 1 });
    profile.release();
  });

  it("ignores lost-context results and resets freshness on restoration or another recording", () => {
    const { engine, ready } = fixture();
    const samples: EngineGpuTimingSample[] = [];
    const profile = observeEngineGpuTiming(engine, sample => samples.push(sample));
    ready(1_000_000); ready(2_000_000);
    engine.onContextLostObservable.notifyObservers(engine);
    ready(3_000_000);
    engine.onContextRestoredObservable.notifyObservers(engine);
    ready(4_000_000); ready(5_000_000);
    profile.release();
    const next = observeEngineGpuTiming(engine, sample => samples.push(sample));
    ready(6_000_000); ready(7_000_000);
    next.release();
    expect(samples.map(sample => sample.durationMs)).toEqual([2, 5, 7]);
  });

  it("detaches on a consumer error and never starts unsupported WebGPU collection", () => {
    const { engine, capture, ready } = fixture();
    const onError = vi.fn();
    const profile = observeEngineGpuTiming(engine, () => { throw new Error("Collector failed"); }, { onError });
    ready(1); ready(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenLastCalledWith(false);
    expect(engine.onEndFrameObservable.hasObservers()).toBe(false);
    profile.release();
    Object.defineProperty(engine, "isWebGPU", { value: true });
    capture.mockClear();
    expect(observeEngineGpuTiming(engine, () => {})).toMatchObject({ status: "unavailable", reason: expect.stringContaining("WebGPU") });
    expect(readEngineGpuTiming(engine)).toBeNull();
    expect(capture).not.toHaveBeenCalled();
  });

  it("restores the prior switch if query activation fails", () => {
    const { engine, capture } = fixture();
    capture.mockImplementationOnce(() => { throw new Error("Query activation failed"); });
    const observation = observeEngineGpuTiming(engine, () => {});
    expect(observation).toMatchObject({ status: "unavailable", reason: expect.stringContaining("Query activation failed") });
    expect(capture.mock.calls).toEqual([[true], [false]]);
    expect(engine.onBeginFrameObservable.hasObservers()).toBe(false);
    expect(engine.onEndFrameObservable.hasObservers()).toBe(false);
    observation.release();
  });

  it("can stop safely after engine disposal without restoring a dead context", () => {
    const { engine, capture } = fixture();
    const lease = acquireEngineGpuTiming(engine)!;
    const profile = observeEngineGpuTiming(engine, () => {});
    engine.dispose();
    capture.mockClear();
    profile.release(); lease.release();
    expect(capture).not.toHaveBeenCalled();
    expect(observeEngineGpuTiming(engine, () => {})).toMatchObject({ status: "unavailable" });
  });
});
