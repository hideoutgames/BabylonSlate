import { describe, expect, it } from "vitest";
import { CPU_SYNTHETIC_REPEATS, cpuComputeKernel, cpuMemoryKernel, runCpuSyntheticLoad } from "./cpu-synthetic-load";

describe("the synthetic CPU load", () => {
  it("does the same work every run: its kernels return the same values each time", () => {
    const compute = cpuComputeKernel();
    const memory = cpuMemoryKernel();
    expect(Number.isFinite(compute)).toBe(true);
    expect(cpuComputeKernel()).toBe(compute);
    expect(cpuMemoryKernel()).toBe(memory);
    expect(runCpuSyntheticLoad(() => 0).value).toBe(runCpuSyntheticLoad(() => 0).value);
  });

  it("times each compute repeat and the memory walk on the clock it is given, giving the fastest and median repeat", () => {
    // Each reading of the clock advances it: the repeats take 3, 1, 5, 2 and 4 ms, then the memory walk 7 ms.
    const spans = [3, 1, 5, 2, 4, 7];
    let now = 0;
    let reading = 0;
    const clock = () => {
      if (reading++ % 2) now += spans[(reading - 2) / 2]!;
      return now;
    };
    const load = runCpuSyntheticLoad(clock);
    expect(load).toMatchObject({ minMs: 1, medianMs: 3, memoryMs: 7 });
    expect(reading).toBe(2 * (CPU_SYNTHETIC_REPEATS + 1));
  });
});
