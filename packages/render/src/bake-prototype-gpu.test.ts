import { expect, it } from "vitest";
import type { WebGLRenderer, WebGLRenderTarget } from "three";
import { readBakePixels, waitForBakeGpu } from "./bake-prototype-gpu";

function gpu() {
  const fences = new Set<object>();
  const buffers = new Set<object>();
  let packed: object | null = null;
  const previous = { width: 2, height: 2 } as WebGLRenderTarget;
  let target: WebGLRenderTarget | null = previous;
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 0x9117, ALREADY_SIGNALED: 0x911a,
    CONDITION_SATISFIED: 0x911c, TIMEOUT_EXPIRED: 0x911b,
    PIXEL_PACK_BUFFER: 0x88eb, STREAM_READ: 0x88e1, RGBA: 0x1908, FLOAT: 0x1406,
    fenceSync: () => { const value = {}; fences.add(value); return value; },
    deleteSync: (value: object) => { fences.delete(value); },
    createBuffer: () => { const value = {}; buffers.add(value); return value; },
    deleteBuffer: (value: object) => { buffers.delete(value); },
    bindBuffer: (_kind: number, value: object | null) => { packed = value; },
    bufferData() {}, readPixels() {}, flush() {}, isContextLost: () => false,
    clientWaitSync: () => 0x911c,
    getBufferSubData: (_kind: number, _offset: number, values: Float32Array) => {
      if (!packed || !buffers.has(packed)) throw new Error("No live readback buffer");
      values.set([1, 2, 3, 1]);
    },
  };
  const renderer = {
    getContext: () => gl,
    getRenderTarget: () => target,
    setRenderTarget: (value: WebGLRenderTarget | null) => { target = value; },
  } as unknown as WebGLRenderer;
  return { gl, context: gl as unknown as WebGL2RenderingContext, renderer, previous,
    state: () => ({ fences: fences.size, buffers: buffers.size, packed, target }) };
}

it("does not finish a tile before the GPU signals completion", async () => {
  const device = gpu();
  let ready = false, completed = false;
  device.gl.clientWaitSync = () => ready ? 0x911c : 0x911b;
  let release!: () => void;
  const checkpoint = new Promise<void>((resolve) => { release = resolve; });
  const pending = waitForBakeGpu(device.context, () => checkpoint).then(() => { completed = true; });
  expect(completed).toBe(false);
  ready = true;
  release();
  await pending;
  expect(completed).toBe(true);
  expect(device.state().fences).toBe(0);
});

it.each(["abort", "GPU failure"])("releases readback resources on %s and admits a following read", async (reason) => {
  const device = gpu();
  const destination = new Float32Array(4);
  const target = { width: 1, height: 1 } as WebGLRenderTarget;
  const failure = new DOMException("Cancelled", "AbortError");
  if (reason === "GPU failure") device.gl.clientWaitSync = () => 0x911d;
  const checkpoint = async () => { if (reason === "abort") throw failure; };
  await expect(readBakePixels(device.renderer, target, destination, checkpoint)).rejects.toThrow(
    reason === "abort" ? "Cancelled" : "Bake GPU completion wait failed",
  );
  expect(device.state()).toEqual({ fences: 0, buffers: 0, packed: null, target: device.previous });
  expect([...destination]).toEqual([0, 0, 0, 0]);
  device.gl.clientWaitSync = () => 0x911c;
  await readBakePixels(device.renderer, target, destination, async () => {});
  expect([...destination]).toEqual([1, 2, 3, 1]);
  expect(device.state()).toEqual({ fences: 0, buffers: 0, packed: null, target: device.previous });
});
