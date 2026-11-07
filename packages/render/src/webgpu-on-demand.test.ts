import { afterEach, describe, expect, it, vi } from "vitest";

// Evaluating the WebGPU code is the fetch of player-webgpu.js in the player; the factory records each evaluation.
const { evaluated } = vi.hoisted(() => ({ evaluated: vi.fn() }));
vi.mock("./webgpu-engine", () => {
  evaluated();
  return { createAppWebGpuEngine: vi.fn(), whenWebGpuDeviceLost: vi.fn() };
});
import { loadWebGpuEngineModule } from "./webgpu-on-demand";

describe("on-demand WebGPU code", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never loads in a browser without WebGPU, then loads once WebGPU is there", async () => {
    for (const gpu of [undefined, null]) {
      vi.stubGlobal("navigator", { userAgent: "", ...(gpu === undefined ? {} : { gpu }) });
      await expect(loadWebGpuEngineModule()).rejects.toThrow("WebGPU is unavailable in this browser.");
    }
    expect(evaluated).not.toHaveBeenCalled();
    vi.stubGlobal("navigator", { userAgent: "", gpu: {} });
    await expect(loadWebGpuEngineModule()).resolves.toHaveProperty("createAppWebGpuEngine");
    expect(evaluated).toHaveBeenCalledTimes(1);
  });
});
