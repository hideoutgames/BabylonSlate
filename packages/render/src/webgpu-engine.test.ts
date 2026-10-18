import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineStore, Observable } from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { createAppWebGpuEngine, watchWebGpuDevice, whenWebGpuDeviceLost } from "./webgpu-engine";

/** Native constructor listener surface; the GPU adapter/device is the I/O seam. */
class CanvasSurface {
  width = 8;
  height = 8;
  style: Record<string, string> = {};
  listeners = new Set<EventListener>();
  addEventListener(_type: string, listener: EventListener) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: EventListener) {
    this.listeners.delete(listener);
  }
  setAttribute() {}
}

describe("WebGPU project Engine initialization", () => {
  afterEach(() => vi.unstubAllGlobals());

  function host(requestAdapter: () => Promise<unknown>) {
    vi.stubGlobal("navigator", {
      userAgent: "",
      gpu: { requestAdapter, getPreferredCanvasFormat: () => "rgba8unorm" },
    });
    const canvas = new CanvasSurface();
    return { canvas, element: canvas as unknown as HTMLCanvasElement };
  }

  it("retains the adapter failure and releases native ownership and listeners", async () => {
    const failure = new Error("Adapter unavailable");
    const { canvas, element } = host(() => Promise.reject(failure));
    const before = [...EngineStore.Instances];
    await expect(createAppWebGpuEngine(element)).rejects.toBe(failure);
    expect(EngineStore.Instances).toEqual(before);
    expect(canvas.listeners.size).toBe(0);
  });

  it("destroys a device acquired before initialization fails without losing the cause", async () => {
    const failure = new Error("Device initialization failed");
    const destroy = vi.fn();
    const { canvas, element } = host(async () => ({
      features: new Set(),
      limits: {},
      info: {},
      requestDevice: async () => ({
        get features() {
          throw failure;
        },
        destroy,
      }),
    }));
    const before = [...EngineStore.Instances];
    await expect(createAppWebGpuEngine(element)).rejects.toBe(failure);
    expect(destroy).toHaveBeenCalledOnce();
    expect(EngineStore.Instances).toEqual(before);
    expect(canvas.listeners.size).toBe(0);
  });

  it("releases ownership even if destroying a partially initialized device throws", async () => {
    const failure = new Error("Initialization failed");
    const cleanup = new Error("Device cleanup failed");
    const { canvas, element } = host(async () => ({
      features: new Set(),
      limits: {},
      info: {},
      requestDevice: async () => ({
        get features() {
          throw failure;
        },
        destroy() {
          throw cleanup;
        },
      }),
    }));
    const before = [...EngineStore.Instances];
    const result = await createAppWebGpuEngine(element).catch(
      (error: unknown) => error,
    );
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).cause).toBe(failure);
    expect(
      ((result as AggregateError).errors[1] as AggregateError).errors,
    ).toContain(cleanup);
    expect(EngineStore.Instances).toEqual(before);
    expect(canvas.listeners.size).toBe(0);
  });

  it("requests the adapter's inter-stage variable limit and leaves other limits at their defaults", async () => {
    const stop = new Error("Device request inspected");
    const requested: unknown[] = [];
    const { element } = host(async () => ({
      features: new Set(),
      limits: {
        maxInterStageShaderVariables: 28,
        maxUniformBuffersPerShaderStage: 24,
        maxBindGroups: 8,
      },
      info: {},
      requestDevice: async (descriptor: GPUDeviceDescriptor) => {
        // The browser converts the descriptor when requestDevice is called.
        requested.push({ ...descriptor.requiredLimits });
        throw stop;
      },
    }));
    await expect(createAppWebGpuEngine(element)).rejects.toBe(stop);
    expect(requested).toEqual([{ maxInterStageShaderVariables: 28 }]);
  });

  it("does not allocate or request an adapter for an already cancelled transition", async () => {
    const requestAdapter = vi.fn(async () => null);
    const { element } = host(requestAdapter);
    const controller = new AbortController();
    const reason = new Error("Superseded backend");
    controller.abort(reason);
    const before = [...EngineStore.Instances];
    await expect(
      createAppWebGpuEngine(element, {}, controller.signal),
    ).rejects.toBe(reason);
    expect(requestAdapter).not.toHaveBeenCalled();
    expect(EngineStore.Instances).toEqual(before);
  });
});

describe("WebGPU device loss", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Prototype-level WebGPUEngine around a device whose loss the test controls. */
  function engineWithDevice() {
    let lose!: (info: { reason: string; message: string }) => void;
    const lost = new Promise<{ reason: string; message: string }>((resolve) => { lose = resolve; });
    const engine = Object.assign(Object.create(WebGPUEngine.prototype), {
      _isDisposed: false,
      _contextWasLost: false,
      onContextLostObservable: new Observable(),
      _device: { lost, addEventListener() {} },
    }) as WebGPUEngine;
    watchWebGpuDevice(engine);
    return { engine, lose };
  }

  it("marks the Engine lost, notifies its context-lost observers and reports the loss", async () => {
    const { engine, lose } = engineWithDevice();
    const observer = vi.fn();
    engine.onContextLostObservable.add(observer);
    vi.spyOn(console, "error").mockImplementation(() => {});

    lose({ reason: "unknown", message: "Out of memory" });

    await expect(whenWebGpuDeviceLost(engine)).resolves.toEqual({ reason: "unknown", message: "Out of memory" });
    expect(observer).toHaveBeenCalledOnce();
    // Babylon's render loop skips frames while this is set.
    expect((engine as unknown as { _contextWasLost: boolean })._contextWasLost).toBe(true);
  });

  it("does not treat the device destroyed by disposal as a loss", async () => {
    const { engine, lose } = engineWithDevice();
    const observer = vi.fn();
    engine.onContextLostObservable.add(observer);
    const reported = vi.fn();
    void whenWebGpuDeviceLost(engine)!.then(reported);

    (engine as unknown as { _isDisposed: boolean })._isDisposed = true;
    lose({ reason: "destroyed", message: "" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(observer).not.toHaveBeenCalled();
    expect(reported).not.toHaveBeenCalled();
  });
});
