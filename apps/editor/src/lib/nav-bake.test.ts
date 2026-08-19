import { describe, expect, it, vi } from "vitest";
import { runNavBake } from "./nav-bake";

describe("runNavBake", () => {
  it("paints a frame, collects, generates in the worker hook, then writes bytes", async () => {
    const phases: string[] = [];
    const generate = vi.fn(async () => new Uint8Array([7, 8, 9]));
    const write = vi.fn(async () => {});
    const collect = vi.fn(() => ({
      positions: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
      indices: [0, 3, 2, 0, 2, 1],
    }));
    await runNavBake({
      waitPaintedFrame: async () => {
        phases.push("painted");
      },
      collect,
      generate,
      write,
      settings: { cellSize: 0.3, supportDynamicObstacles: true },
      onPhase: (phase) => phases.push(phase),
    });
    expect(phases).toEqual([
      "showing",
      "painted",
      "collecting",
      "generating",
      "writing",
    ]);
    expect(collect).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith({
      positions: expect.any(Array),
      indices: expect.any(Array),
      settings: { cellSize: 0.3, supportDynamicObstacles: true },
    });
    expect(write).toHaveBeenCalledWith(new Uint8Array([7, 8, 9]));
  });

  it("retries collect when the first painted frame has no geometry yet", async () => {
    const generate = vi.fn(async () => new Uint8Array([4, 5]));
    const write = vi.fn(async () => {});
    let calls = 0;
    await runNavBake({
      waitPaintedFrame: async () => {},
      collect: () => {
        calls += 1;
        if (calls === 1) return { positions: [], indices: [] };
        return {
          positions: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
          indices: [0, 3, 2, 0, 2, 1],
        };
      },
      generate,
      write,
      settings: {},
      onPhase: () => {},
    });
    expect(calls).toBe(2);
    expect(generate).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(new Uint8Array([4, 5]));
  });

  it("does not generate when collect returns empty geometry", async () => {
    const generate = vi.fn(async () => new Uint8Array([1]));
    await expect(
      runNavBake({
        waitPaintedFrame: async () => {},
        collect: () => ({ positions: [], indices: [] }),
        generate,
        write: async () => {},
        settings: {},
        onPhase: () => {},
      }),
    ).rejects.toThrow(/geometry/i);
    expect(generate).not.toHaveBeenCalled();
  });

  it("skips write when cancelled after collect", async () => {
    const controller = new AbortController();
    const write = vi.fn(async () => {});
    const generate = vi.fn(async () => {
      controller.abort();
      return new Uint8Array([1]);
    });
    await expect(
      runNavBake({
        waitPaintedFrame: async () => {},
        collect: () => ({
          positions: [0, 0, 0, 1, 0, 0, 0, 0, 1],
          indices: [0, 1, 2],
        }),
        generate,
        write,
        settings: {},
        onPhase: () => {},
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
    expect(write).not.toHaveBeenCalled();
  });

  it("awaits async collect before generate", async () => {
    const generate = vi.fn(async () => new Uint8Array([1, 2]));
    await runNavBake({
      waitPaintedFrame: async () => {},
      collect: async () => ({
        positions: [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
        indices: [0, 3, 2, 0, 2, 1],
      }),
      generate,
      write: async () => {},
      settings: {},
      onPhase: () => {},
    });
    expect(generate).toHaveBeenCalledOnce();
  });
});
