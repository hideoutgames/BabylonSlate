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
});
