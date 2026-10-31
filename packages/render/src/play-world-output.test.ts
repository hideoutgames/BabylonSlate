import { afterEach, describe, expect, it } from "vitest";
import { NullEngine, RenderTargetTexture, Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";
import { PlayWorldOutput, playOutputSizes } from "./play-world-output";

describe("playOutputSizes", () => {
  it.each([
    // view, device pixel ratio, world level → backbuffer, world
    [{ width: 400, height: 300 }, 1, 1, { width: 400, height: 300 }, { width: 400, height: 300 }],
    [{ width: 400, height: 300 }, 2, 1, { width: 800, height: 600 }, { width: 400, height: 300 }],
    [{ width: 400, height: 300 }, 2, 2, { width: 800, height: 600 }, { width: 200, height: 150 }],
    [{ width: 400, height: 300 }, 1, 1 / 0.85, { width: 400, height: 300 }, { width: 340, height: 255 }],
    [{ width: 1180, height: 820 }, 2, 1.25, { width: 2360, height: 1640 }, { width: 944, height: 656 }],
    [{ width: 401, height: 301 }, 1.5, 4, { width: 601, height: 451 }, { width: 100, height: 75 }],
  ])("sizes a %o view at ratio %d and world level %d", (view, ratio, level, composition, world) => {
    expect(playOutputSizes(view, ratio, level)).toEqual({ composition, world });
  });

  it("falls back to one for a missing ratio or level and never sizes below one pixel", () => {
    expect(playOutputSizes({ width: 0, height: 10 }, Number.NaN, 0)).toEqual({
      composition: { width: 1, height: 10 }, world: { width: 1, height: 10 },
    });
    expect(playOutputSizes({ width: 2, height: 2 }, 1, 4).world).toEqual({ width: 1, height: 1 });
  });
});

describe("PlayWorldOutput", () => {
  const engines: NullEngine[] = [];
  afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
  function world() {
    // NullEngine raw uploads (the blit's fallback texture) are made ready as a browser upload is.
    const engine = adaptNullEngineFrameGraph(new NullEngine());
    engines.push(engine);
    const scene = new Scene(engine);
    const camera = new UniversalCamera("world", new Vector3(0, 0, -10), scene);
    scene.activeCamera = camera;
    return { scene, camera, output: new PlayWorldOutput(scene) };
  }

  it("gives the active camera a single-sample colour and depth target at the world size", () => {
    const { camera, output } = world();
    output.resize(320, 180);
    const target = camera.outputRenderTarget!;
    expect(target).toBe(output.texture());
    expect(target.getSize()).toEqual({ width: 320, height: 180 });
    expect(target.samples).toBe(1);
    expect(target.depthStencilTexture).not.toBeNull();
  });

  it("replaces the target on a resize and keeps it on an unchanged size", () => {
    const { camera, output } = world();
    output.resize(320, 180);
    const first = output.texture()!;
    output.resize(320, 180);
    expect(output.texture()).toBe(first);
    output.resize(160, 90);
    expect(output.texture()).not.toBe(first);
    expect(first.getInternalTexture()).toBeNull();
    expect(camera.outputRenderTarget).toBe(output.texture());
  });

  it("moves the target to a newly active camera and leaves a capture camera's own target alone", () => {
    const { scene, camera, output } = world();
    output.resize(320, 180);
    const next = new UniversalCamera("next", Vector3.Zero(), scene);
    scene.activeCamera = next;
    expect(next.outputRenderTarget).toBe(output.texture());
    expect(camera.outputRenderTarget).toBeNull();
    const capture = new UniversalCamera("capture", Vector3.Zero(), scene);
    const own = new RenderTargetTexture("capture", 64, scene);
    capture.outputRenderTarget = own;
    scene.activeCamera = capture;
    expect(capture.outputRenderTarget).toBe(own);
    expect(next.outputRenderTarget).toBe(output.texture());
    scene.activeCamera = next;
    expect(next.outputRenderTarget).toBe(output.texture());
  });

  it("presents once its blit is ready and releases the target and camera on dispose", async () => {
    const { camera, output } = world();
    expect(output.present()).toBe(false);
    output.resize(320, 180);
    await output.prepare(() => {});
    expect(output.isReady()).toBe(true);
    expect(output.present()).toBe(true);
    const target = output.texture()!;
    output.dispose();
    expect(camera.outputRenderTarget).toBeNull();
    expect(target.getInternalTexture()).toBeNull();
  });
});
