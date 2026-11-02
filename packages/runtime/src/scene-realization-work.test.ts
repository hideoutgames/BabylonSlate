import { afterEach, describe, expect, it, vi } from "vitest";
import { runSceneRealizationWork, sceneRealizationCancelled } from "./scene-realization-work";

afterEach(() => vi.useRealTimers());

function* countedSteps(counter: { steps: number }, total: number): Generator<void, void, unknown> {
  for (let index = 0; index < total; index++) {
    counter.steps++;
    yield;
  }
}

describe("runSceneRealizationWork", () => {
  it("yields between chunks with tasks that no timer clamp delays", async () => {
    // Timers are frozen: a yield through setTimeout would never resume.
    vi.useFakeTimers();
    const counter = { steps: 0 };
    await runSceneRealizationWork(countedSteps(counter, 5), new AbortController().signal, { stepsPerYield: 1 });
    expect(counter.steps).toBe(5);
  });

  it("rejects a cancellation during a yield and runs no further step", async () => {
    const controller = new AbortController();
    const counter = { steps: 0 };
    const work = runSceneRealizationWork(countedSteps(counter, 5), controller.signal, { stepsPerYield: 1 });
    controller.abort(sceneRealizationCancelled());
    await expect(work).rejects.toMatchObject({ name: "AbortError" });
    expect(counter.steps).toBe(1);
  });
});
