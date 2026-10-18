import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineStore, Observable } from "@babylonjs/core";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { forwardLightBudget } from "./forward-light-budget";
import {
  REQUESTED_UNIFORM_BUFFERS_PER_SHADER_STAGE,
  createAppWebGpuEngine,
  watchWebGpuDevice,
  whenWebGpuDeviceLost,
} from "./webgpu-engine";

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

  describe("requested device limits", () => {
    /** Runs initialization against an adapter with these limits; returns what the device request carried. */
    async function requestedLimits(adapterLimits: Record<string, number>) {
      const stop = new Error("Device request inspected");
      const requested: unknown[] = [];
      const { element } = host(async () => ({
        features: new Set(),
        limits: adapterLimits,
        info: {},
        requestDevice: async (descriptor: GPUDeviceDescriptor) => {
          // The browser converts the descriptor when requestDevice is called.
          requested.push({ ...descriptor.requiredLimits });
          throw stop;
        },
      }));
      await expect(createAppWebGpuEngine(element)).rejects.toBe(stop);
      expect(requested).toHaveLength(1);
      return requested[0] as Record<string, number>;
    }

    it("requests the adapter's inter-stage variable limit and leaves other limits at their defaults", async () => {
      expect(
        await requestedLimits({
          maxInterStageShaderVariables: 28,
          maxUniformBuffersPerShaderStage: 12,
          maxBindGroups: 8,
        }),
      ).toEqual({ maxInterStageShaderVariables: 28 });
    });

    it("asks for nothing from an adapter that reports no limits", async () => {
      expect(await requestedLimits({})).toEqual({});
    });

    it.each([
      [16, 16],
      [44, REQUESTED_UNIFORM_BUFFERS_PER_SHADER_STAGE],
      [REQUESTED_UNIFORM_BUFFERS_PER_SHADER_STAGE + 1, REQUESTED_UNIFORM_BUFFERS_PER_SHADER_STAGE],
    ])(
      "raises the uniform buffer limit from an adapter offering %i to %i",
      async (offered, requested) => {
        const limits = await requestedLimits({
          maxInterStageShaderVariables: 28,
          maxUniformBuffersPerShaderStage: offered,
        });
        expect(limits.maxUniformBuffersPerShaderStage).toBe(requested);
        // Never above what the adapter offers, or the device request is refused.
        expect(limits.maxUniformBuffersPerShaderStage).toBeLessThanOrEqual(offered);
        expect(limits.maxInterStageShaderVariables).toBe(28);
      },
    );

    it.each([12, 8])(
      "leaves the uniform buffer limit at its default for an adapter offering %i",
      async (offered) => {
        expect(
          await requestedLimits({ maxUniformBuffersPerShaderStage: offered }),
        ).not.toHaveProperty("maxUniformBuffersPerShaderStage");
      },
    );
  });

  it.each([
    [12, 8],
    [44, REQUESTED_UNIFORM_BUFFERS_PER_SHADER_STAGE - 4],
  ])(
    "derives the forward light budget of an adapter offering %i uniform buffers from the limit its device was granted (%i slots)",
    async (offered, expectedSlots) => {
      const stop = new Error("Stopped after the limits were read");
      const before = [...EngineStore.Instances];
      const adapterLimits: Record<string, number> = {
        maxInterStageShaderVariables: 28,
        maxUniformBuffersPerShaderStage: offered,
      };
      const slots: number[] = [];
      const { element } = host(async () => ({
        features: new Set(),
        limits: adapterLimits,
        info: {},
        requestDevice: async (descriptor: GPUDeviceDescriptor) => {
          const required = { ...descriptor.requiredLimits };
          // A browser refuses a request above the adapter's limits.
          for (const [name, value] of Object.entries(required))
            if ((value ?? 0) > (adapterLimits[name] ?? 0)) throw new Error(`Limit ${name} is not supported.`);
          // The device gets the WebGPU defaults overlaid with the request.
          const base = {
            features: new Set(),
            limits: { maxUniformBuffersPerShaderStage: 12, ...required },
            lost: new Promise(() => {}),
            addEventListener() {},
            destroy() {},
          };
          // Babylon derives its caps from the limits, then creates its first
          // device resource; stop there with the Engine's caps in place.
          return new Proxy(base, {
            get(target, property) {
              // Not a thenable: the device is awaited as a request result.
              if (typeof property === "symbol" || property === "then" || property in target)
                return Reflect.get(target, property);
              return () => {
                const engine = EngineStore.Instances.find((candidate) => !before.includes(candidate))!;
                slots.push(forwardLightBudget(engine).slots);
                throw stop;
              };
            },
          });
        },
      }));
      await expect(createAppWebGpuEngine(element)).rejects.toBe(stop);
      expect(slots).toEqual([expectedSlots]);
    },
  );

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
