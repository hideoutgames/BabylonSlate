import { expect, it } from "vitest";
import { desktopMemoryStats } from "./desktop-memory";

it("reports the calling renderer, the GPU and main processes and every process, in bytes", () => {
  const metrics = [
    { pid: 1, type: "Browser", memory: { workingSetSize: 100 } },
    { pid: 2, type: "GPU", memory: { workingSetSize: 400 } },
    { pid: 3, type: "Tab", memory: { workingSetSize: 300 } },
    // Another window's renderer counts only toward the total.
    { pid: 4, type: "Tab", memory: { workingSetSize: 50 } },
    { pid: 5, type: "Utility", memory: { workingSetSize: 10 } },
  ];
  expect(desktopMemoryStats(metrics, 3)).toEqual({
    rendererProcessBytes: 300 * 1024,
    gpuProcessBytes: 400 * 1024,
    mainProcessBytes: 100 * 1024,
    allProcessesBytes: 860 * 1024,
  });
});

it("reports a process it cannot find as unknown rather than zero", () => {
  expect(desktopMemoryStats([{ pid: 1, type: "Browser", memory: { workingSetSize: 8 } }], 9)).toEqual({
    rendererProcessBytes: null, gpuProcessBytes: null, mainProcessBytes: 8 * 1024, allProcessesBytes: 8 * 1024,
  });
});
