import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Logger, NullEngine, RawTexture, Scene } from "@babylonjs/core";
import { RGBDTextureTools } from "@babylonjs/core/Misc/rgbdTextureTools";
import { isSceneTextureWorkReady } from "./scene-perf";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const engine = new NullEngine();
  engine.getCaps().textureHalfFloatRender = true;
  engine.getCaps().textureHalfFloatLinearFiltering = true;
  const scene = new Scene(engine);
  const texture = RawTexture.CreateRGBATexture(new Uint8Array([128, 64, 32, 128]), 1, 1, scene);
  const internal = texture.getInternalTexture()!;
  internal.isReady = true;
  texture.isRGBD = true;
  const compiler = deferred();
  const createEffect = engine.createEffect.bind(engine);
  vi.spyOn(engine, "createEffect").mockImplementation((baseName, options, ...args) => {
    if (!Array.isArray(options)) {
      const initialize = options.extraInitializationsAsync;
      options = { ...options, extraInitializationsAsync: async () => { await initialize?.(); await compiler.promise; } };
    }
    return createEffect(baseName, options, ...args);
  });
  const allocation = vi.spyOn(engine, "createRenderTargetTexture");
  const draw = vi.spyOn(scene.postProcessManager, "directRender");
  const release = vi.spyOn(engine, "_releaseTexture");
  const shader = vi.spyOn(engine, "createShaderProgram");
  const errors = vi.spyOn(Logger, "Error").mockImplementation(() => {});
  return { engine, scene, texture, internal, compiler, allocation, draw, release, shader, errors };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("pinned native RGBD texture lifecycle", () => {
  it("does not allocate or draw when its scene is disposed during shader import", async () => {
    const { engine, scene, texture, compiler, allocation, draw } = fixture();
    try {
      RGBDTextureTools.ExpandRGBDTexture(texture);
      scene.dispose();
      compiler.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(allocation).not.toHaveBeenCalled();
      expect(draw).not.toHaveBeenCalled();
      expect(engine.postProcesses).toEqual([]);
    } finally { engine.dispose(); }
  });

  it.each(["texture disposal", "scene disposal", "context loss"] as const)("releases pending owned decode resources on %s and prevents late shader creation or framebuffer writes", async (reason) => {
    const { engine, scene, texture, internal, compiler, allocation, draw, shader } = fixture();
    try {
      RGBDTextureTools.ExpandRGBDTexture(texture);
      await vi.waitFor(() => expect(allocation).toHaveBeenCalledOnce());
      const target = allocation.mock.results[0]!.value!;
      const disposeTarget = vi.spyOn(target, "dispose");
      const restore = vi.spyOn(engine, "restoreDefaultFramebuffer");
      if (reason === "texture disposal") texture.dispose();
      else if (reason === "scene disposal") scene.dispose();
      else engine.onContextLostObservable.notifyObservers(engine);
      const restoresAtCancellation = restore.mock.calls.length;
      compiler.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(draw).not.toHaveBeenCalled();
      expect(shader).not.toHaveBeenCalled();
      expect(restore).toHaveBeenCalledTimes(restoresAtCancellation);
      expect(disposeTarget).toHaveBeenCalledOnce();
      expect(engine.postProcesses).toEqual([]);
      expect(internal.isReady).toBe(false);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it.each([false, true])("restores the exact caller framebuffer, read binding, viewport and depth state when decode throws=%s", async (throws) => {
    const { engine, scene, texture, internal, compiler, allocation, draw, errors } = fixture();
    const context = engine as unknown as { _gl: unknown; _currentFramebuffer: unknown; _currentRenderTarget: unknown; _viewportCached: { x: number; y: number; z: number; w: number }; _webGLVersion: number };
    const previousGl = context._gl;
    const target = engine.createRenderTargetTexture(8, { generateDepthBuffer: false });
    const framebuffer = { face: 4, mip: 2 };
    const readFramebuffer = { read: true };
    let bound: unknown = framebuffer;
    let readBound: unknown = readFramebuffer;
    let viewport = [2, 3, 5, 7];
    const gl = {
      FRAMEBUFFER: 1, FRAMEBUFFER_BINDING: 2, READ_FRAMEBUFFER: 3, READ_FRAMEBUFFER_BINDING: 4, VIEWPORT: 5,
      getParameter: (parameter: number) => parameter === 2 ? bound : parameter === 4 ? readBound : [...viewport],
      bindFramebuffer: (parameter: number, value: unknown) => { if (parameter === 1) { bound = value; readBound = value; } else readBound = value; },
      viewport: (x: number, y: number, width: number, height: number) => { viewport = [x, y, width, height]; },
      deleteProgram() {},
    };
    try {
      allocation.mockClear();
      draw.mockImplementation(() => {
        bound = { decoded: true }; readBound = bound; viewport = [0, 0, 1, 1];
        context._viewportCached = { x: 0, y: 0, z: 1, w: 1 };
        engine.setDepthWrite(true); engine.setDepthBuffer(true);
        if (throws) throw new Error("Decode draw failed");
      });
      RGBDTextureTools.ExpandRGBDTexture(texture);
      await vi.waitFor(() => expect(allocation).toHaveBeenCalledOnce());
      const ownedTarget = allocation.mock.results[0]!.value!;
      const disposeTarget = vi.spyOn(ownedTarget, "dispose");
      // Model the external WebGL state at the GPU draw boundary, after native
      // shader creation. Keep the actual PostProcess/Effect/RTT lifetime path.
      const effect = vi.mocked(engine.createEffect).mock.results[0]!.value!;
      effect.onCompileObservable.add(() => {
        context._gl = gl;
        context._webGLVersion = 2;
        context._currentRenderTarget = target;
        context._currentFramebuffer = framebuffer;
        context._viewportCached = { x: 2, y: 3, z: 5, w: 7 };
        engine.setDepthWrite(false); engine.setDepthBuffer(false);
      }, -1, true);
      compiler.resolve();
      await vi.waitFor(() => expect(draw).toHaveBeenCalledOnce());
      expect(bound).toBe(framebuffer);
      expect(readBound).toBe(readFramebuffer);
      expect(viewport).toEqual([2, 3, 5, 7]);
      expect(context._currentRenderTarget).toBe(target);
      expect(context._currentFramebuffer).toBe(framebuffer);
      expect(engine.getDepthWrite()).toBe(false);
      expect(engine.getDepthBuffer()).toBe(false);
      expect(disposeTarget).toHaveBeenCalledOnce();
      expect(engine.postProcesses).toEqual([]);
      expect(internal.isReady).toBe(!throws);
      expect(texture.loadingError).toBe(throws);
      if (throws) expect(() => isSceneTextureWorkReady(scene)).toThrow("RGBD texture decode failed");
      expect(errors.mock.calls.length).toBe(throws ? 1 : 0);
    } finally { context._gl = previousGl; context._currentRenderTarget = null; scene.dispose(); target.dispose(); engine.dispose(); }
  });

  it("keeps a sibling decode alive when another scene releases their shared pending shader", async () => {
    const { engine, scene, texture, compiler, allocation, errors } = fixture();
    const sibling = new Scene(engine);
    const siblingTexture = RawTexture.CreateRGBATexture(new Uint8Array([128, 64, 32, 128]), 1, 1, sibling);
    siblingTexture.getInternalTexture()!.isReady = true;
    siblingTexture.isRGBD = true;
    const siblingDraw = vi.spyOn(sibling.postProcessManager, "directRender");
    try {
      RGBDTextureTools.ExpandRGBDTexture(texture);
      RGBDTextureTools.ExpandRGBDTexture(siblingTexture);
      await vi.waitFor(() => expect(allocation).toHaveBeenCalledTimes(2));
      scene.dispose();
      compiler.resolve();
      await vi.waitFor(() => expect(siblingTexture.isReady()).toBe(true));
      expect(siblingDraw).toHaveBeenCalledOnce();
      expect(engine.postProcesses).toEqual([]);
      expect(errors).not.toHaveBeenCalled();
    } finally { scene.dispose(); sibling.dispose(); engine.dispose(); }
  });

  it("bounds a stalled compiler, exposes the owned texture failure and suppresses later completion", async () => {
    const { engine, scene, texture, compiler, allocation, draw, errors } = fixture();
    vi.useFakeTimers();
    try {
      RGBDTextureTools.ExpandRGBDTexture(texture);
      await vi.waitFor(() => expect(allocation).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(30_000);
      expect(texture.loadingError).toBe(true);
      expect(() => isSceneTextureWorkReady(scene)).toThrow("RGBD texture decode failed");
      expect(errors).toHaveBeenCalledOnce();
      expect(engine.postProcesses).toEqual([]);
      compiler.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(draw).not.toHaveBeenCalled();
      expect(texture.isReady()).toBe(false);
    } finally { scene.dispose(); engine.dispose(); }
  });

  it.each([false, true])("preserves live async Effect preparation failures and suppresses only disposed Effect errors: disposed=%s", async (disposed) => {
    const engine = new NullEngine();
    let reject!: (error: Error) => void;
    const imports = new Promise<void>((_resolve, fail) => { reject = fail; });
    const errors = vi.fn();
    vi.spyOn(Logger, "Error").mockImplementation(() => {});
    const shader = vi.spyOn(engine, "createShaderProgram");
    const effect = new Effect({ vertexSource: "void main() { gl_Position = vec4(0.0); }", fragmentSource: "void main() { gl_FragColor = vec4(1.0); }" },
      { attributes: [], uniformsNames: [], samplers: [], defines: "", extraInitializationsAsync: () => imports }, engine);
    effect.onErrorObservable.add(errors);
    try {
      if (disposed) effect.dispose();
      reject(new Error("Owned shader import unavailable"));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(errors.mock.calls.length).toBe(disposed ? 0 : 1);
      expect(shader).not.toHaveBeenCalled();
      if (!disposed) expect(effect.getCompilationError()).toContain("Owned shader import unavailable");
    } finally { effect.dispose(); engine.dispose(); }
  });
});
