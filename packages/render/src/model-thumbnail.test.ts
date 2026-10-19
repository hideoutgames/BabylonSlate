import { PBRMaterial, RenderTargetTexture, type Mesh } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestEngine as createNullTestEngine } from "./create-null-engine";
import { adaptNullEngineFrameGraph } from "./framegraph-test-fixtures";

/** Thumbnails draw through the FrameGraph into a color/depth target. */
function createTestEngine() {
  const handle = createNullTestEngine();
  adaptNullEngineFrameGraph(handle.engine);
  return handle;
}
import {
  encodeParentedAnimatedTriangleGlb,
  encodeTriangleGlb,
} from "./glb-test-fixtures";
import { captureModelThumbnailPng } from "./model-thumbnail";
import { PNG_SIGNATURE } from "./png-encode";
import { nativePreparationForEngine } from "./native-preparation";
import { PreparationTimedOut, SceneRenderCoordinator } from "./scene-render-coordinator";
import { SCENE_CAPTURE_CEILING_MS } from "./stall-deadline";
import type { ThumbnailCaptureResult } from "./thumbnail-capture";
import { installVirtualClock, POLL_MS } from "./virtual-clock-test-fixtures";

/** The PNG of a capture that produced one. */
const pngOf = (result: ThumbnailCaptureResult) => result.outcome === "captured" ? result.png : undefined;

describe("captureModelThumbnailPng", () => {
  const handles: Array<{
    engine: { dispose: () => void };
    scene: { dispose: () => void };
  }> = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("encodes a transparent PNG of the loaded mesh", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const pixels = new Uint8Array(128 * 128 * 4);
    pixels[3] = 0;
    vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockResolvedValue(
      pixels,
    );
    const png = pngOf(await captureModelThumbnailPng(
      handle.engine,
      encodeTriangleGlb(),
      [],
      () => null,
    ));
    expect(png).toBeDefined();
    expect([...png!.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
  });

  it("captures construction materials when slot resolve returns null", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const pixels = new Uint8Array(128 * 128 * 4);
    vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockResolvedValue(
      pixels,
    );
    const png = pngOf(await captureModelThumbnailPng(
      handle.engine,
      encodeTriangleGlb(),
      [{ index: 0, name: "Hero Mat", materialGuid: "mat-1" }],
      () => null,
    ));
    expect(png).toBeDefined();
    expect([...png!.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
  });

  it("admits thumbnail decode behind gameplay on the engine's native preparation queue", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const scheduler = nativePreparationForEngine(handle.engine, { maxConcurrent: 1 });
    let unblock!: () => void;
    const blocker = scheduler.schedule({ label: "Active Gameplay", temporaryBytes: 1 }, () => new Promise<void>((resolve) => { unblock = resolve; }));
    const order: string[] = [];
    vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockImplementation(async () => {
      order.push("thumbnail");
      return new Uint8Array(128 * 128 * 4);
    });
    const capture = captureModelThumbnailPng(handle.engine, encodeTriangleGlb(), [], () => null);
    expect(scheduler.snapshot()).toMatchObject({ active: 1, queued: 1 });
    const gameplay = scheduler.schedule({ label: "Next Actor", temporaryBytes: 1 }, async () => { order.push("gameplay"); });
    unblock();
    await Promise.all([blocker, gameplay]);
    expect(pngOf(await capture)).toBeDefined();
    expect(order).toEqual(["gameplay", "thumbnail"]);
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, temporaryBytes: 0 });
    expect(scheduler.snapshot().peakTemporaryBytes).toBeGreaterThanOrEqual(encodeTriangleGlb().byteLength * 4);
    expect(handle.engine.scenes).toEqual([handle.scene]);
  });

  it("rejects an oversized thumbnail and cancels queued decode without leaving a capture scene", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const bytes = encodeTriangleGlb();
    const scheduler = nativePreparationForEngine(handle.engine, { maxConcurrent: 1, temporaryBytes: bytes.byteLength * 4 - 1 });
    const readback = vi.spyOn(RenderTargetTexture.prototype, "readPixels");
    // Refused for its size: another attempt would be refused too.
    expect(await captureModelThumbnailPng(handle.engine, bytes, [], () => null)).toEqual({ outcome: "failed" });
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, peakTemporaryBytes: 0 });
    expect(handle.engine.scenes).toEqual([handle.scene]);

    const other = createTestEngine();
    handles.push(other);
    const queuedScheduler = nativePreparationForEngine(other.engine, { maxConcurrent: 1 });
    let unblock!: () => void;
    const blocker = queuedScheduler.schedule({ label: "Gameplay", temporaryBytes: 1 }, () => new Promise<void>((resolve) => { unblock = resolve; }));
    const controller = new AbortController();
    const capture = captureModelThumbnailPng(other.engine, bytes, [], () => null, undefined, { signal: controller.signal });
    expect(queuedScheduler.snapshot().queued).toBe(1);
    controller.abort();
    expect(await capture).toEqual({ outcome: "cancelled" });
    expect(queuedScheduler.snapshot()).toMatchObject({ active: 1, queued: 0, temporaryBytes: 1 });
    expect(other.engine.scenes).toEqual([other.scene]);
    expect(readback).not.toHaveBeenCalled();
    unblock();
    await blocker;
  });

  it("holds target, retarget and readback admission until cancelled capture cleanup finishes", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const scheduler = nativePreparationForEngine(handle.engine, { maxConcurrent: 1 });
    const bytes = encodeParentedAnimatedTriangleGlb("Idle");
    const sourceClipBytes = encodeParentedAnimatedTriangleGlb("Idle");
    const controller = new AbortController();
    let finish!: (pixels: Uint8Array) => void;
    const readback = vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const capture = captureModelThumbnailPng(handle.engine, bytes, [], () => null, undefined, { clipName: "Idle", sourceClipBytes, signal: controller.signal });
    await vi.waitFor(() => expect(readback).toHaveBeenCalledOnce());
    controller.abort();
    expect(scheduler.snapshot().active).toBe(1);
    expect(scheduler.snapshot().temporaryBytes).toBeGreaterThan((bytes.byteLength + sourceClipBytes.byteLength) * 4);
    let scenesWhenAdmitted: unknown;
    const gameplay = scheduler.schedule({ label: "Next Actor", temporaryBytes: 1 }, async () => { scenesWhenAdmitted = [...handle.engine.scenes]; });
    expect(scheduler.snapshot().queued).toBe(1);
    finish(new Uint8Array(128 * 128 * 4));
    expect(await capture).toEqual({ outcome: "cancelled" });
    await gameplay;
    expect(scenesWhenAdmitted).toEqual([handle.scene]);
    expect(scheduler.snapshot()).toMatchObject({ active: 0, queued: 0, temporaryBytes: 0 });
  });

  it("captures a Model.source view nested in a larger ArrayBuffer", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const glb = encodeTriangleGlb();
    const padded = new Uint8Array(glb.byteLength + 32);
    padded.fill(0xab);
    padded.set(glb, 16);
    const view = padded.subarray(16, 16 + glb.byteLength);
    const pixels = new Uint8Array(128 * 128 * 4);
    vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockResolvedValue(
      pixels,
    );
    const png = pngOf(await captureModelThumbnailPng(
      handle.engine,
      view,
      [],
      () => null,
    ));
    expect(png).toBeDefined();
    expect([...png!.subarray(0, 8)]).toEqual([...PNG_SIGNATURE]);
  });

  it("waits for imported materials before reading the one-shot render", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    let materialReady = false;
    const isReady = PBRMaterial.prototype.isReadyForSubMesh;
    const readiness = vi
      .spyOn(PBRMaterial.prototype, "isReadyForSubMesh")
      .mockImplementation(function (this: PBRMaterial, ...args) {
        return materialReady && isReady.apply(this, args);
      });
    const readback = vi
      .spyOn(RenderTargetTexture.prototype, "readPixels")
      .mockResolvedValue(new Uint8Array(128 * 128 * 4));
    const capture = captureModelThumbnailPng(
      handle.engine,
      encodeTriangleGlb(),
      [],
      () => null,
    );
    await vi.waitFor(() => expect(readiness).toHaveBeenCalled());
    expect(readback).not.toHaveBeenCalled();
    materialReady = true;
    expect(pngOf(await capture)).toBeDefined();
    expect(readback).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "captures the selected clip's first pose, including retargeted clips: %s",
    async (retargeted) => {
      const handle = createTestEngine();
      handles.push(handle);
      const posed = encodeParentedAnimatedTriangleGlb("Idle");
      const view = new DataView(
        posed.buffer,
        posed.byteOffset,
        posed.byteLength,
      );
      const binOffset = 28 + view.getUint32(12, true);
      // First key is visibly different from the rest pose and the later key.
      view.setFloat32(binOffset + 48, 2, true);
      view.setFloat32(binOffset + 60, 6, true);
      let capturedY: number | undefined;
      vi.spyOn(RenderTargetTexture.prototype, "readPixels").mockImplementation(
        function (this: RenderTargetTexture) {
          capturedY = (this.getScene()!.getMeshByName("part") as Mesh).position
            .y;
          return Promise.resolve(new Uint8Array(128 * 128 * 4));
        },
      );
      const png = pngOf(await captureModelThumbnailPng(
        handle.engine,
        retargeted ? encodeParentedAnimatedTriangleGlb("Idle") : posed,
        [],
        () => null,
        undefined,
        { clipName: "Idle", ...(retargeted ? { sourceClipBytes: posed } : {}) },
      ));
      expect(png).toBeDefined();
      expect(capturedY).toBeCloseTo(2);
      expect(handle.engine.scenes).toEqual([handle.scene]);
    },
  );

  it("releases the capture scene when a material never becomes ready", async () => {
    vi.useFakeTimers();
    const handle = createTestEngine();
    handles.push(handle);
    vi.spyOn(PBRMaterial.prototype, "isReadyForSubMesh").mockReturnValue(false);
    const readback = vi.spyOn(RenderTargetTexture.prototype, "readPixels");
    const capture = captureModelThumbnailPng(
      handle.engine,
      encodeTriangleGlb(),
      [],
      () => null,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await capture).toEqual({ outcome: "expired", reason: "bound" });
    expect(readback).not.toHaveBeenCalled();
    expect(handle.engine.scenes).toEqual([handle.scene]);
  });

  // A retry of a capture that ran out passes a longer ceiling; unrelated shaders finishing on the Engine renew the wait until it.
  describe("with shaders finishing elsewhere on the Engine while the model never becomes ready", () => {
    function neverReady(handle: ReturnType<typeof createTestEngine>) {
      const clock = installVirtualClock();
      const effects = (handle.engine as unknown as { _compiledEffects: Record<string, unknown> })._compiledEffects;
      let probes = 0;
      vi.spyOn(PBRMaterial.prototype, "isReadyForSubMesh").mockImplementation(() => {
        probes += 1;
        effects[`elsewhere-${probes}`] = { isReady: () => true, getCompilationError: () => "" };
        clock.advance(POLL_MS);
        return false;
      });
      return clock;
    }

    it.each([
      ["its ceiling", undefined, SCENE_CAPTURE_CEILING_MS],
      ["the ceiling it was given", { ceilingMs: 1.5 * SCENE_CAPTURE_CEILING_MS }, 1.5 * SCENE_CAPTURE_CEILING_MS],
    ])("expires at %s", { timeout: 30_000 }, async (_name, options, ceiling) => {
      const handle = createTestEngine();
      handles.push(handle);
      const clock = neverReady(handle);
      expect(await captureModelThumbnailPng(handle.engine, encodeTriangleGlb(), [], () => null, undefined, options)).toEqual({ outcome: "expired", reason: "ceiling" });
      expect(clock.elapsed()).toBeGreaterThanOrEqual(ceiling);
      expect(clock.elapsed()).toBeLessThanOrEqual(ceiling + POLL_MS);
    });

    it("stops waiting as soon as the capture is cancelled", async () => {
      const handle = createTestEngine();
      handles.push(handle);
      const controller = new AbortController();
      const clock = neverReady(handle);
      const capture = captureModelThumbnailPng(handle.engine, encodeTriangleGlb(), [], () => null, undefined, { signal: controller.signal });
      await vi.waitFor(() => expect(PBRMaterial.prototype.isReadyForSubMesh).toHaveBeenCalled());
      controller.abort();
      expect(await capture).toEqual({ outcome: "cancelled" });
      expect(clock.elapsed()).toBeLessThan(SCENE_CAPTURE_CEILING_MS);
    });
  });

  it("does not cache a rest pose when the requested animation is absent", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const readback = vi.spyOn(RenderTargetTexture.prototype, "readPixels");
    expect(
      await captureModelThumbnailPng(
        handle.engine,
        encodeParentedAnimatedTriangleGlb("Idle"),
        [],
        () => null,
        undefined,
        { clipName: "Missing" },
      ),
    ).toEqual({ outcome: "failed" });
    expect(readback).not.toHaveBeenCalled();
    expect(handle.engine.scenes).toEqual([handle.scene]);
  });

  describe("when the frame graph's preparation rejects before the ceiling", () => {
    it("reports a render error as a failure, which another attempt would repeat", async () => {
      const handle = createTestEngine();
      handles.push(handle);
      vi.spyOn(SceneRenderCoordinator.prototype, "prepare").mockRejectedValue(new Error("Scene rendering requires an active camera."));
      expect(await captureModelThumbnailPng(handle.engine, encodeTriangleGlb(), [], () => null)).toEqual({ outcome: "failed" });
      expect(handle.engine.scenes).toEqual([handle.scene]);
    });

    it("reports its own timeout as an expired bound, which a longer ceiling does not change", async () => {
      const handle = createTestEngine();
      handles.push(handle);
      vi.spyOn(SceneRenderCoordinator.prototype, "prepare").mockRejectedValue(new PreparationTimedOut("Scene rendering preparation timed out."));
      expect(await captureModelThumbnailPng(handle.engine, encodeTriangleGlb(), [], () => null)).toEqual({ outcome: "expired", reason: "bound" });
      expect(handle.engine.scenes).toEqual([handle.scene]);
    });
  });

  it("reports a failure for OBJ stubs with no loadable mesh", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    await expect(
      captureModelThumbnailPng(
        handle.engine,
        new TextEncoder().encode("o cube\nv 0 0 0\n"),
        [],
        () => null,
      ),
    ).resolves.toEqual({ outcome: "failed" });
  });
});
