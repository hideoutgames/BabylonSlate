import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineStore } from "@babylonjs/core";
import { createAppWebGpuEngine } from "./webgpu-engine";

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
