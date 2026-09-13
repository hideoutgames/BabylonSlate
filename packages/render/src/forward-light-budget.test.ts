import { Observable, type AbstractEngine } from "@babylonjs/core";
import { describe, expect, it, vi } from "vitest";
import { forwardLightBudget } from "./forward-light-budget";

function device(values: number[]) {
  const restored = new Observable<AbstractEngine>();
  const getParameter = vi.fn((parameter: number) => values[parameter]);
  const engine = {
    supportsUniformBuffers: true,
    onContextRestoredObservable: restored,
    _gl: {
      MAX_VERTEX_UNIFORM_BLOCKS: 0,
      MAX_FRAGMENT_UNIFORM_BLOCKS: 1,
      MAX_UNIFORM_BUFFER_BINDINGS: 2,
      MAX_COMBINED_UNIFORM_BLOCKS: 3,
      getParameter,
    },
  } as unknown as AbstractEngine;
  return { engine, restored, getParameter };
}

describe("conventional forward shader admission", () => {
  it.each([
    [[14, 24, 36, 48], 11],
    [[24, 10, 36, 48], 7],
    [[24, 24, 8, 48], 5],
    [[24, 24, 36, 16], 5],
    [[3, 24, 36, 48], 0],
  ])(
    "reserves non-light blocks against all device limits %j",
    (values, slots) => {
      const { engine } = device(values as number[]);
      expect(forwardLightBudget(engine)).toMatchObject({
        slots,
        source: "webgl2",
        reservedBlocks: 3,
      });
    },
  );

  it("queries once per context and re-reads after restoration", () => {
    const values = [14, 24, 36, 48];
    const { engine, restored, getParameter } = device(values);
    expect(forwardLightBudget(engine).slots).toBe(11);
    expect(forwardLightBudget(engine).slots).toBe(11);
    expect(getParameter).toHaveBeenCalledTimes(4);
    values[0] = 12;
    restored.notifyObservers(engine);
    expect(forwardLightBudget(engine).slots).toBe(9);
    expect(getParameter).toHaveBeenCalledTimes(8);
  });

  it("uses conservative WebGL2 minima when queries fail", () => {
    const { engine, getParameter } = device([]);
    getParameter.mockImplementation(() => {
      throw new Error("context unavailable");
    });
    expect(forwardLightBudget(engine)).toMatchObject({
      slots: 9,
      source: "webgl2-minimum",
    });
  });
});
