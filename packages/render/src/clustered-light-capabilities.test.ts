import { describe, expect, it } from "vitest";
import { Observable, type AbstractEngine } from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { clusteredLightCapabilities } from "./clustered-light-capabilities";

function fakeWebGpuEngine(limits: Record<string, number>): AbstractEngine {
  // Prototype-level instance: WebGPUEngine's constructor needs a real device.
  return Object.assign(Object.create(WebGPUEngine.prototype), {
    onContextRestoredObservable: new Observable(),
    onDisposeObservable: new Observable(),
    _isWebGPU: true,
    _deviceLimits: limits,
    _caps: { maxTextureSize: 16384 },
  }) as AbstractEngine;
}

const adequate = {
  maxStorageBuffersPerShaderStage: 8,
  maxStorageBufferBindingSize: 134217728,
};

describe("clusteredLightCapabilities WebGPU admission", () => {
  it("admits a WebGPUEngine with adequate storage limits", () => {
    const result = clusteredLightCapabilities(fakeWebGpuEngine(adequate));
    expect(result).toEqual({
      supported: true,
      backend: "webgpu",
      batchSize: 32,
      maxTextureSize: 16384,
    });
  });

  it("admits compat-mode limits when the fragment stage exposes storage", () => {
    const result = clusteredLightCapabilities(
      fakeWebGpuEngine({
        ...adequate,
        maxStorageBuffersInFragmentStage: 1,
      }),
    );
    expect(result.supported).toBe(true);
  });

  it("rejects a missing per-stage storage buffer slot by name", () => {
    const result = clusteredLightCapabilities(
      fakeWebGpuEngine({
        ...adequate,
        maxStorageBuffersPerShaderStage: 0,
      }),
    );
    expect(result).toEqual({
      supported: false,
      reason: "WebGPU clustered requires maxStorageBuffersPerShaderStage >= 1.",
    });
  });

  it("rejects an undersized storage buffer binding by name", () => {
    const result = clusteredLightCapabilities(
      fakeWebGpuEngine({
        ...adequate,
        maxStorageBufferBindingSize: 64 * 64 * 4,
      }),
    );
    expect(result).toEqual({
      supported: false,
      reason:
        "WebGPU clustered requires maxStorageBufferBindingSize >= 524288.",
    });
  });

  it("rejects compat-mode zero fragment storage by name", () => {
    const result = clusteredLightCapabilities(
      fakeWebGpuEngine({
        ...adequate,
        maxStorageBuffersInFragmentStage: 0,
      }),
    );
    expect(result).toEqual({
      supported: false,
      reason:
        "WebGPU clustered requires maxStorageBuffersInFragmentStage >= 1.",
    });
  });

  it("rejects a WebGPU-flagged engine that is not a WebGPUEngine", () => {
    const engine = {
      isWebGPU: true,
      onContextRestoredObservable: new Observable(),
      onDisposeObservable: new Observable(),
      getCaps: () => ({ maxTextureSize: 16384 }),
    } as unknown as AbstractEngine;
    const result = clusteredLightCapabilities(engine);
    expect(result).toEqual({
      supported: false,
      reason: "WebGPU clustered admission requires a WebGPUEngine.",
    });
  });
});
