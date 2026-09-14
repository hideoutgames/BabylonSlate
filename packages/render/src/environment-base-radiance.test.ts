import { afterEach, expect, it, vi } from "vitest";
import { Constants, CubeTexture, NullEngine, Viewport } from "@babylonjs/core";
import { readEnvironmentBaseRadiance } from "./environment-base-radiance";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const engine = new NullEngine();
  Object.assign(engine.getCaps(), {
    textureFloatRender: true,
    textureFloat: true,
    textureLOD: true,
  });
  // NullEngine has no cube upload IO. Keep real texture/effect/target lifecycle.
  vi.spyOn(engine, "createCubeTexture").mockImplementation((url) => {
    const internal = engine.createTexture(url, false, false, null);
    internal.isCube = true;
    internal.width = internal.height = 64;
    return internal;
  });
  const source = new CubeTexture("numeric.dds", engine);
  return { engine, source };
}

it("restores the owning Engine before deferred readback and releases temporary storage after all reads settle", async () => {
  const { engine, source } = fixture();
  try {
    const previous = engine.createRenderTargetTexture(16, {});
    engine.bindFramebuffer(previous);
    engine.setViewport(new Viewport(0.1, 0.2, 0.6, 0.7));
    engine.setAlphaMode(Constants.ALPHA_ADD);
    engine.setDepthWrite(true);
    engine.setColorWrite(false);
    engine.depthCullingState.cull = false;
    engine.depthCullingState.zOffset = 3;
    engine.stencilState.stencilTest = true;
    const before = engine.getLoadedTexturesCache().length;
    const observers = engine.onContextRestoredObservable.observers.length;
    const finish: Array<(pixels: Float32Array) => void> = [];
    const read = vi
      .spyOn(engine, "_readTexturePixels")
      .mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
    const operation = readEnvironmentBaseRadiance(source, () => true);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(6));
    expect(engine._currentRenderTarget).toBe(previous);
    expect(engine.currentViewport).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.6,
      height: 0.7,
    });
    expect(engine.getAlphaMode()).toBe(Constants.ALPHA_ADD);
    expect(engine.getDepthWrite()).toBe(true);
    expect(engine.getColorWrite()).toBe(false);
    expect(engine.depthCullingState.cull).toBe(false);
    expect(engine.depthCullingState.zOffset).toBe(3);
    expect(engine.stencilState.stencilTest).toBe(true);
    expect(engine.getLoadedTexturesCache().length).toBe(before + 1);
    for (const resolve of finish) resolve(new Float32Array(32 * 32 * 4));
    expect(await operation).toMatchObject({ size: 32, linear: true });
    await vi.waitFor(() => expect(engine.onContextRestoredObservable.observers.length).toBe(observers));
    expect(engine._currentRenderTarget).toBe(previous);
    expect(source.isReady()).toBe(true);
    previous.dispose();
  } finally {
    source.dispose();
    engine.dispose();
  }
});

it("restores state and disposes its temporary target on a draw failure, and rejects unsupported HDR targets before allocation", async () => {
  const { engine, source } = fixture();
  try {
    const before = engine.onContextRestoredObservable.observers.length;
    engine.setViewport(new Viewport(0, 0, 0.5, 0.5));
    engine.setColorWrite(false);
    const target = vi.spyOn(engine, "createRenderTargetTexture");
    const draw = vi.spyOn(engine, "drawElementsType").mockImplementation(() => {
      throw new Error("draw failed");
    });
    await expect(
      readEnvironmentBaseRadiance(source, () => true),
    ).rejects.toThrow("draw failed");
    expect(engine.currentViewport?.width).toBe(0.5);
    expect(engine.getColorWrite()).toBe(false);
    expect(engine._currentRenderTarget).toBeNull();
    await vi.waitFor(() => expect(engine.onContextRestoredObservable.observers.length).toBe(before));
    expect(target.mock.results[0]!.value.texture).toBeNull();
    draw.mockRestore();
    target.mockClear();
    Object.assign(engine.getCaps(), {
      textureFloatRender: false,
      textureHalfFloatRender: false,
    });
    await expect(
      readEnvironmentBaseRadiance(source, () => true),
    ).rejects.toThrow("float or half-float");
    expect(target).not.toHaveBeenCalled();
  } finally {
    source.dispose();
    engine.dispose();
  }
});
