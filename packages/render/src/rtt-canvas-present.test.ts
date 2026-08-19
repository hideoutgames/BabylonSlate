import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArcRotateCamera,
  NullEngine,
  RenderTargetTexture,
  Scene,
  Vector3,
} from "@babylonjs/core";
import { createRttCanvasPresent } from "./rtt-canvas-present";

class FakeCanvas {
  clientWidth = 128;
  clientHeight = 64;
  width = 0;
  height = 0;
  putCalls = 0;

  getContext(kind: string) {
    if (kind !== "2d") return null;
    return {
      putImageData: () => {
        this.putCalls += 1;
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

  it("reports at least 1x1 when the canvas has no layout size", () => {
    const { scene, canvas, fake } = host();
    fake.clientWidth = 0;
    fake.clientHeight = 0;
    const present = createRttCanvasPresent(scene, canvas);
    expect(present.canvasSize()).toEqual({ width: 1, height: 1 });
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
    present.blit();
    await vi.waitFor(() => {
      expect(fake.putCalls).toBe(1);
    });
    expect(fake.width).toBe(128);
    expect(fake.height).toBe(64);
    readPixels.mockRestore();
    present.dispose();
    globalThis.ImageData = previous;
  });
});
