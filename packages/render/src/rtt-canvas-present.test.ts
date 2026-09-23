import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArcRotateCamera,
  NullEngine,
  RenderTargetTexture,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { createRttCanvasPresent } from "./rtt-canvas-present";
import { mockDepthTextureIO } from "./texture-test-fixtures";

class FakeCanvas {
  clientWidth = 128;
  clientHeight = 64;
  width = 0;
  height = 0;
  putCalls = 0;
  capturedImages: Array<{ data: Uint8ClampedArray }> = [];

  getContext(kind: string) {
    if (kind !== "2d") return null;
    return {
      putImageData: (image?: { data: Uint8ClampedArray }) => {
        this.putCalls += 1;
        if (image) this.capturedImages.push(image);
      },
    };
  }
}

describe("createRttCanvasPresent", () => {
  const engines: NullEngine[] = [];

  afterEach(() => {
    while (engines.length > 0) {
      engines.pop()?.dispose();
    }
  });

  function host() {
    const engine = new NullEngine();
    mockDepthTextureIO(engine);
    engines.push(engine);
    const scene = new Scene(engine);
    const camera = new ArcRotateCamera(
      "cam",
      0,
      Math.PI / 4,
      10,
      Vector3.Zero(),
      scene,
    );
    scene.activeCamera = camera;
    const canvas = new FakeCanvas() as unknown as HTMLCanvasElement;
    return { engine, scene, camera, canvas, fake: canvas as unknown as FakeCanvas };
  }

  it("binds an RTT without calling registerView", () => {
    const { engine, scene, camera, canvas } = host();
    const registerView = vi.spyOn(engine, "registerView");
    const present = createRttCanvasPresent(scene, canvas, { name: "prefabPreview" });
    present.bind();
    expect(registerView).not.toHaveBeenCalled();
    expect(camera.outputRenderTarget).not.toBeNull();
    present.dispose();
    expect(camera.outputRenderTarget).toBeNull();
  });

  it("applies hardware scaling to the offscreen target", () => {
    const { engine, scene, camera, canvas } = host();
    vi.spyOn(engine, "getHardwareScalingLevel").mockReturnValue(2);
    const present = createRttCanvasPresent(scene, canvas);
    present.bind();
    expect(camera.outputRenderTarget?.getSize()).toMatchObject({ width: 64, height: 32 });
    present.dispose();
  });

  it("reports at least 1x1 when the canvas has no layout size", () => {
    const { scene, canvas, fake } = host();
    fake.clientWidth = 0;
    fake.clientHeight = 0;
    const present = createRttCanvasPresent(scene, canvas);
    expect(present.canvasSize()).toEqual({ width: 1, height: 1 });
    present.dispose();
  });

  it("clears the 2D canvas bitmap on resize without throwing", () => {
    const { scene, canvas, fake } = host();
    fake.width = 32;
    fake.height = 16;
    const present = createRttCanvasPresent(scene, canvas);
    present.clear();
    expect(fake.width).toBe(128);
    expect(fake.height).toBe(64);
    present.dispose();
  });

  it("blits readPixels into the 2D canvas", async () => {
    const { scene, camera, canvas, fake } = host();
    const ImageDataStub = class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    };
    const previous = globalThis.ImageData;
    globalThis.ImageData = ImageDataStub as unknown as typeof ImageData;
    const present = createRttCanvasPresent(scene, canvas);
    present.bind();
    const texture = camera.outputRenderTarget as RenderTargetTexture;
    const pixels = new Uint8Array(128 * 64 * 4);
    const readPixels = vi
      .spyOn(texture, "readPixels")
      .mockResolvedValue(
        pixels as unknown as Awaited<ReturnType<RenderTargetTexture["readPixels"]>>,
      );
    await present.blit();
    await vi.waitFor(() => {
      expect(fake.putCalls).toBe(1);
    });
    expect(fake.width).toBe(128);
    expect(fake.height).toBe(64);
    readPixels.mockRestore();
    present.dispose();
    globalThis.ImageData = previous;
  });

  it("rejects a disposed readback and never paints its delayed pixels", async () => {
    const { scene, camera, canvas, fake } = host();
    const present = createRttCanvasPresent(scene, canvas);
    present.bind();
    let resolve!: (pixels: Uint8Array) => void;
    const read = new Promise<Uint8Array>((done) => { resolve = done; });
    vi.spyOn(camera.outputRenderTarget!, "readPixels").mockReturnValue(read);
    const pending = present.blit();
    const rejected = expect(pending).rejects.toThrow("disposed");
    expect(present.isPresenting()).toBe(true);
    expect(fake.putCalls).toBe(0);
    present.dispose();
    await rejected;
    resolve(new Uint8Array(128 * 64 * 4));
    await read;
    await Promise.resolve();
    expect(fake.putCalls).toBe(0);
    expect(present.isPresenting()).toBe(false);
  });

  it("flips Babylon render-target rows for the 2D canvas", async () => {
    const { scene, camera, canvas } = host();
    const first = [0, 0, 255, 255];
    const last = [255, 0, 0, 255];
    const width = 128;
    const height = 64;
    const row = width * 4;
    const gpu = new Uint8Array(width * height * 4);
    for (let x = 0; x < width; x++) {
      const bottom = x * 4;
      gpu[bottom] = 255;
      gpu[bottom + 3] = 255;
      const top = (height - 1) * row + x * 4;
      gpu[top + 2] = 255;
      gpu[top + 3] = 255;
    }
    const fake = canvas as unknown as FakeCanvas;
    const ImageDataStub = class {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    };
    const previous = globalThis.ImageData;
    globalThis.ImageData = ImageDataStub as unknown as typeof ImageData;
    const present = createRttCanvasPresent(scene, canvas);
    present.bind();
    const texture = camera.outputRenderTarget as RenderTargetTexture;
    const readPixels = vi
      .spyOn(texture, "readPixels")
      .mockResolvedValue(
        gpu as unknown as Awaited<ReturnType<RenderTargetTexture["readPixels"]>>,
      );
    await present.blit();
    await vi.waitFor(() => expect(fake.capturedImages.length).toBeGreaterThan(0));
    const image = fake.capturedImages[0]!;
    expect([...image.data.subarray(0, 4)]).toEqual(first);
    expect([
      ...image.data.subarray((height - 1) * row, (height - 1) * row + 4),
    ]).toEqual(last);
    readPixels.mockRestore();
    present.dispose();
    globalThis.ImageData = previous;
  });
});
