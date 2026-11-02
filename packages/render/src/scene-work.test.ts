import { afterEach, describe, expect, it, vi } from "vitest";
import { runSceneWork } from "./scene-work";

function* steps(count: number): Generator<number, void, unknown> {
  for (let index = 0; index < count; index++) yield index / count;
}

async function yieldsFor(count: number, stepsPerYield?: number): Promise<number> {
  let yields = 0;
  await runSceneWork(steps(count), {
    signal: new AbortController().signal,
    stepsPerYield,
    yieldControl: async () => { yields++; },
  });
  return yields;
}

afterEach(() => vi.restoreAllMocks());

describe("runSceneWork yield policy", () => {
  it("yields once the time budget is spent, however few steps ran", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 3));
    expect(await yieldsFor(10)).toBe(3);
  });

  it("lets cheap steps share a run, bounded by the requested step count", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    expect(await yieldsFor(600, 100)).toBe(6);
  });

  it("reports progress once per run, before its yield, and at the end", async () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const events: string[] = [];
    await runSceneWork(steps(250), {
      signal: new AbortController().signal,
      stepsPerYield: 100,
      onProgress: (value) => events.push(`progress ${value}`),
      yieldControl: async () => { events.push("yield"); },
    });
    expect(events).toEqual(["progress 0.396", "yield", "progress 0.796", "yield", "progress 0.996"]);
  });

  it("yields a task turn without the nested-timer clamp, and stops on abort", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (now += 10));
    await runSceneWork(steps(5), { signal: new AbortController().signal });
    // Every step spends the budget, so each yields: through a message port, never a timer.
    expect(timeout).not.toHaveBeenCalled();
    const controller = new AbortController();
    const run = runSceneWork(steps(5), { signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(run).rejects.toThrow("cancelled");
  });
});
