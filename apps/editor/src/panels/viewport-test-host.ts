import type { AbstractEngine } from "@babylonjs/core";
import { EngineStore, Vector3 } from "@babylonjs/core";
import type { RefObject } from "react";
import type { SerializedScene } from "@haptic/core";
import {
  applyGizmoMultiSelectDrag,
  beginGizmoMultiSelectDrag,
  captureShadowDiagnostics,
  selectionGizmoRoots,
  setDirectViewPresentationEnabled,
  setFixedShapeLightGuard,
  setFixedShapeLightingEnabled,
  whenSubmittedWorkDone,
  type EngineHandle,
} from "@haptic/render";
import { subscribeAppSettings } from "../context/app-settings-context";
import {
  materialViewportTestSnapshot,
  type MaterialViewportTestSnapshot,
} from "../lib/material-viewport-test-snapshot";

/** The test-build hooks e2e specs drive through `globalThis.__hapticViewportTest`. */
export type ViewportTestHost = {
  __hapticViewportTest?: {
    commitGizmoNudge: () => Promise<boolean>;
    commitMultiSelectGizmoNudge: () => Promise<boolean>;
    activeSceneMeshPosition: () => [number, number, number] | null;
    actorCanvasFraction: (actorId: string) => { x: number; y: number } | null;
    sceneTexturePixels: () => Promise<unknown>;
    sceneVisuals: () => Array<
      MaterialViewportTestSnapshot & {
        actorId: string;
        position: [number, number, number];
        materialName: string | null;
      }
    >;
    hardwareScalingLevel: () => number | null;
    postProcessPassCount: () => number | null;
    renderingBaseline: () => Record<string, unknown> | null;
    shadowDiagnostics: () => ReturnType<typeof captureShadowDiagnostics> | null;
    mannequinShadowProbe: (modelOnly?: boolean) => Promise<unknown>;
    mannequinShadowVisibility: (points: { worldPosition: number[]; region: string }[]) => Promise<boolean[]>;
    setRenderSettings: EngineHandle["setRenderSettings"];
    setShadowCaptureView: (position: [number, number, number], target: [number, number, number], fov: number) => void;
    environmentTextureSamples: () => Promise<Record<string, unknown> | null>;
    environmentLightingProof: () => Promise<Record<string, unknown>>;
    measureRenderingBaseline: (durationMs: number) => Promise<Record<string, unknown>>;
    /** Direct presentation of a sole view (default on); off copies into the view canvas, for A/B runs. */
    setDirectViewPresentation: (enabled: boolean) => void;
    /** Fixed-shape forward lighting on the project Engine with that seat guard, or off (null), for A/B runs; false without a view. */
    setFixedShapeLighting: (guard: "multiply" | "branch" | null) => boolean;
    /** Destroys the project Engine's WebGPU device, as a real loss would; false on WebGL2 or without a view. */
    destroyGraphicsDevice: () => boolean;
    /**
     * Hold (or resume) this viewport's frames: no step draws or presents (scene loading still may), though a
     * resize still resizes the Engine. Holding resolves once the GPU finished the submitted work, so a
     * screenshot shows what stays on screen.
     */
    holdViewportFrames: (hold: boolean) => Promise<void>;
    webgpuPreviewsProof: (
      options?: import("../testing/webgpu-previews-proof").ViewportProofOptions,
    ) => Promise<
      import("../testing/webgpu-previews-proof").ViewportProofResult
    >;
    engineSceneDiagnostics: () => Promise<
      import("../testing/webgpu-previews-proof").EngineSceneDiagnostics | null
    >;
    /** Fly the editor camera along a path and record per-frame render events (perf routes only). */
    flyThrough: (
      options: import("../testing/flythrough-probe").FlyThroughOptions,
    ) => Promise<import("../testing/flythrough-probe").FlyThroughResult>;
  };
};

export interface ViewportTestHostDeps {
  engineRef: RefObject<EngineHandle | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  sceneRef: RefObject<SerializedScene | null>;
  dragStartSceneRef: RefObject<SerializedScene | null>;
  commitGizmoTransform: () => void;
  ensureSharedEngine: () => AbstractEngine | null;
}

/**
 * Installs `__hapticViewportTest` for one viewport and returns its removal.
 * The panel installs it only in test mode.
 */
export function installViewportTestHost({
  engineRef,
  canvasRef,
  sceneRef,
  dragStartSceneRef,
  commitGizmoTransform,
  ensureSharedEngine,
}: ViewportTestHostDeps): () => void {
  const host = globalThis as ViewportTestHost;
  let viewportFrameCap: number | null = null;
  const unsubscribeSettings = subscribeAppSettings(({ settings }) => {
    viewportFrameCap = settings.viewportFrameCap;
  });
  const measurements = new Set<() => void>();
  let releaseFrameHold: (() => void) | null = null;

    host.__hapticViewportTest = {
    environmentLightingProof: async () => {
      if (import.meta.env.VITE_TEST_MODE !== "true") throw new Error("Environment proof requires a test build.");
      return (await import("../lib/environment-lighting-proof")).runEnvironmentLightingProof();
    },
    webgpuPreviewsProof: async (options) => {
      if (import.meta.env.VITE_TEST_MODE !== "true") throw new Error("Preview proof requires a test build.");
      const handle = engineRef.current;
      const canvas = canvasRef.current;
      if (!handle || !canvas) throw new Error("No active viewport for the preview proof");
      return (await import("../testing/webgpu-previews-proof")).recordViewportProof(handle, canvas, options);
    },
    engineSceneDiagnostics: async () => {
      if (import.meta.env.VITE_TEST_MODE !== "true") throw new Error("Scene diagnostics require a test build.");
      // Preview Scenes live on the shared Engine, which outlives viewport
      // remounts. While the Scene document tab is hidden the viewport handle
      // can be absent (waitForCanvasSize blocks the remount), so read the
      // session engine rather than engineRef.
      const engine = ensureSharedEngine();
      if (!engine) return null;
      return (await import("../testing/webgpu-previews-proof")).collectEngineSceneDiagnostics(engine, engineRef.current?.scene ?? null);
    },
    flyThrough: async (options) => {
      if (import.meta.env.VITE_TEST_MODE !== "true") throw new Error("Fly-through requires a test build.");
      const handle = engineRef.current;
      if (!handle) throw new Error("No active viewport for the fly-through");
      return (await import("../testing/flythrough-probe")).runFlyThrough(handle, options);
    },
    environmentTextureSamples: async () => {
      const handle = engineRef.current;
      const texture = handle?.scene.environmentTexture;
      if (!handle || !texture) return null;
      if (!texture.isReady()) return { ready: false, loadingError: texture.loadingError,
        error: texture.errorObject ? { message: texture.errorObject.message, exception: String(texture.errorObject.exception) } : null,
        size: texture.getSize(), isCube: texture.isCube };
      const size = texture.getSize();
      const lastMip = Math.floor(Math.log2(size.width));
      const samples = [];
      for (const face of [0, 5]) for (const level of [...new Set([0, lastMip])]) {
        const pixels = await texture.readPixels(face, level, undefined, true, false, 0, 0, 1, 1);
        samples.push({ face, level, type: pixels?.constructor.name, values: pixels ? Array.from(pixels as Uint8Array | Float32Array) : null });
      }
      return { size, isCube: texture.isCube, gammaSpace: texture.gammaSpace, samples,
        sceneConsumers: handle.engine.scenes.filter((scene) => scene.environmentTexture === texture).length,
        gpuType: texture.getInternalTexture()?.type };
    },
    measureRenderingBaseline: async (durationMs) => {
      for (const cancel of measurements) cancel();
      const handle = engineRef.current;
      if (!handle) throw new Error("No active viewport for rendering measurement");
      // Keep collection bounded even if a test supplies an invalid duration.
      const requestedMs = Number.isFinite(durationMs)
        ? Math.min(30_000, Math.max(1, durationMs)) : 30_000;
      return new Promise((resolve) => {
        const started = performance.now();
        const frameSamples: Array<{
          atMs: number; intervalMs: number | null; frameDelta: number;
          cpuMs: number; gpuMs: number | null; gpuStatus: string;
          preparationMs: number; copyMs: number; held: number;
          graphBuilds: number; shadowAdmissions: number; shadowAdmissionMs: number;
          viewportFrameCap: number | null; documentVisible: boolean;
        }> = [];
        const resourceSamples: Array<Record<string, number>> = [];
        let lastFrame = handle.renderDiagnostics().presentation?.copied ?? handle.scheduler.stats().renderedFrames;
        let lastDraw = handle.scheduler.stats().renderedFrames;
        let lastPresented: number | null = null;
        let lastResourceAt = -250;
        let droppedSamples = 0;
        let finished = false;
        let previousTextures = new Set(handle.engine.getLoadedTexturesCache());
        let previousTargets = new Set(handle.engine._renderTargetWrapperCache);
        let texturesAdded = 0;
        let texturesRemoved = 0;
        let targetsAdded = 0;
        let targetsRemoved = 0;
        const sampleResources = (atMs: number) => {
          const textures = new Set(handle.engine.getLoadedTexturesCache());
          const targets = new Set(handle.engine._renderTargetWrapperCache);
          for (const texture of textures) if (!previousTextures.has(texture)) texturesAdded += 1;
          for (const texture of previousTextures) if (!textures.has(texture)) texturesRemoved += 1;
          for (const target of targets) if (!previousTargets.has(target)) targetsAdded += 1;
          for (const target of previousTargets) if (!targets.has(target)) targetsRemoved += 1;
          previousTextures = textures;
          previousTargets = targets;
          resourceSamples.push({
            atMs,
            estimatedTextureBytes: handle.resourceCache.accountedBytes(),
            estimatedGeometryBytes: handle.accountedGeometryBytes(),
            estimatedShadowBytes: handle.renderDiagnostics().shadowMapBytes,
            sceneMeshes: handle.scene.meshes.length,
            engineScenes: handle.engine.scenes.length,
            engineTextures: textures.size,
            engineRenderTargets: targets.size,
            texturesAdded, texturesRemoved, targetsAdded, targetsRemoved,
          });
          lastResourceAt = atMs;
        };
        const finish = (cancelled: string | null = null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          handle.engine.onEndFrameObservable.remove(frameObserver);
          handle.engine.onContextLostObservable.remove(lostObserver);
          handle.scene.onDisposeObservable.remove(disposeObserver);
          measurements.delete(cancel);
          const elapsedMs = performance.now() - started;
          if (!cancelled) sampleResources(elapsedMs);
          resolve({ requestedMs, elapsedMs, cancelled, droppedSamples, frameSamples, resourceSamples });
        };
        const cancel = () => finish("Viewport measurement was superseded or disposed");
        const frameObserver = handle.engine.onEndFrameObservable.add(() => {
          if (engineRef.current !== handle || handle.scene.isDisposed) {
            cancel();
            return;
          }
          // Scene viewport copies finish inside the native view step. Avoid
          // scanning resources on shared Engine ticks that did not draw it.
          const draw = handle.scheduler.stats().renderedFrames;
          if (draw === lastDraw) return;
          lastDraw = draw;
          const diagnostics = handle.renderDiagnostics();
          const frame = diagnostics.presentation?.copied ?? handle.scheduler.stats().renderedFrames;
          // Shared Engine end-frame notifications from sibling views are not
          // presentations of this viewport. Count completed view copies.
          if (frame === lastFrame) return;
          const now = performance.now();
          const atMs = now - started;
          if (frameSamples.length < 6_000) {
            frameSamples.push({
              atMs, intervalMs: lastPresented === null ? null : now - lastPresented,
              frameDelta: frame - lastFrame,
              cpuMs: diagnostics.cpuMs, gpuMs: diagnostics.gpuMs,
              gpuStatus: diagnostics.gpuStatus,
              preparationMs: diagnostics.presentation?.preparationMs ?? 0,
              copyMs: diagnostics.presentation?.copyMs ?? 0,
              held: diagnostics.presentation?.held ?? 0,
              graphBuilds: diagnostics.rendererWork?.graphBuilds ?? 0,
              shadowAdmissions: diagnostics.rendererWork?.shadowAdmissions ?? 0,
              shadowAdmissionMs: diagnostics.rendererWork?.shadowAdmissionMs ?? 0,
              viewportFrameCap, documentVisible: document.visibilityState === "visible",
            });
          } else droppedSamples += 1;
          lastFrame = frame;
          lastPresented = now;
          if (atMs - lastResourceAt >= 250) sampleResources(atMs);
        });
        const lostObserver = handle.engine.onContextLostObservable.add(() => finish("Rendering context was lost"));
        const disposeObserver = handle.scene.onDisposeObservable.addOnce(cancel);
        const timer = setTimeout(() => finish(), requestedMs);
        measurements.add(cancel);
        sampleResources(0);
      });
    },
    shadowDiagnostics: () => {
      const handle = engineRef.current;
      return handle ? captureShadowDiagnostics(handle.scene, { host: "editor", meshes: handle.scene.meshes }) : null;
    },
    mannequinShadowProbe: async (modelOnly) => {
      const handle = engineRef.current;
      if (!handle || import.meta.env.VITE_TEST_MODE !== "true") throw new Error("No test viewport");
      const result = (await import("../testing/mannequin-shadow-proof")).mannequinShadowProbe(handle.scene, modelOnly);
      handle.scheduler.invalidate("manual");
      return result;
    },
    mannequinShadowVisibility: async (points) => {
      const handle = engineRef.current;
      if (!handle || import.meta.env.VITE_TEST_MODE !== "true") throw new Error("No test viewport");
      return (await import("../testing/mannequin-shadow-proof")).mannequinShadowVisibility(handle.scene, points);
    },
    setRenderSettings: (settings) => engineRef.current?.setRenderSettings(settings),
    setDirectViewPresentation: (enabled) => setDirectViewPresentationEnabled(enabled),
    setFixedShapeLighting: (guard) => {
      const engine = engineRef.current?.engine;
      if (!engine) return false;
      if (guard) setFixedShapeLightGuard(engine, guard);
      setFixedShapeLightingEnabled(engine, guard !== null);
      engineRef.current?.scheduler.invalidate("asset");
      return true;
    },
    destroyGraphicsDevice: () => {
      const engine = engineRef.current?.engine;
      // Pinned Babylon 9.29 owning-device boundary.
      const device = engine?.isWebGPU ? (engine as unknown as { _device?: { destroy(): void } })._device : undefined;
      if (!device) return false;
      device.destroy();
      return true;
    },
    holdViewportFrames: async (hold) => {
      const handle = engineRef.current;
      if (!handle) throw new Error("No active viewport to hold.");
      if (!hold) {
        releaseFrameHold?.();
        releaseFrameHold = null;
        return;
      }
      // An obstruction lease composes with the resize guard and modal obstruction, which set their own gates.
      releaseFrameHold ??= handle.scheduler.acquireObstruction();
      await whenSubmittedWorkDone(handle.engine);
    },
    setShadowCaptureView: (position, target, fov) => {
      const handle = engineRef.current;
      const camera = handle?.editor?.camera.camera;
      if (!handle || !camera) throw new Error("No editor camera for shadow capture");
      camera.setTarget(Vector3.FromArray(target));
      camera.setPosition(Vector3.FromArray(position));
      camera.fov = fov;
      camera.minZ = 0.1;
      camera.maxZ = 100;
      handle.scheduler.invalidate("camera");
    },
    renderingBaseline: () => {
      const handle = engineRef.current;
      if (!handle) return null;
      const caps = handle.engine.getCaps();
      return {
        userAgent: navigator.userAgent,
        backend: handle.engine.isWebGPU ? "webgpu" : "webgl2",
        engineCount: EngineStore.Instances.length,
        webGLVersion: "webGLVersion" in handle.engine ? handle.engine.webGLVersion : null,
        glInfo: "getGlInfo" in handle.engine && typeof handle.engine.getGlInfo === "function" ? handle.engine.getGlInfo() : null,
        gpuInfo: "getInfo" in handle.engine && typeof handle.engine.getInfo === "function" ? handle.engine.getInfo() : null,
        render: handle.renderDiagnostics(),
        frameCount: handle.scheduler.stats().renderedFrames,
        viewportFrameCap,
        drawCalls: handle.drawCalls(),
        liveObjects: handle.liveObjectCounts(),
        engineScenes: handle.engine.scenes.length,
        estimatedTextureBytes: handle.resourceCache.accountedBytes(),
        estimatedGeometryBytes: handle.accountedGeometryBytes(),
        ktx2Uploads: handle.engine.getLoadedTexturesCache()
          .filter((texture) => texture.isReady && texture._extension === ".ktx2")
          .map((texture) => ({ format: texture.format, type: texture.type, mips: texture.generateMipMaps })),
        sceneOverrides: sceneRef.current?.settings.shadowOverrides,
        capabilities: {
          maxTextureSize: caps.maxTextureSize,
          maxCubemapTextureSize: caps.maxCubemapTextureSize,
          maxTexturesImageUnits: caps.maxTexturesImageUnits,
          textureFloatRender: caps.textureFloatRender,
          textureHalfFloatRender: caps.textureHalfFloatRender,
          timerQuery: !!caps.timerQuery,
        },
      };
    },
    sceneTexturePixels: async () => {
      const sync = engineRef.current?.editor?.sync;
      if (!sync) return [];
      const samples = [];
      for (const actor of sceneRef.current?.actors ?? []) {
        const visual = sync.visualMeshesForActor(actor.id)[0];
        const texture = visual?.material?.getActiveTextures()[0];
        if (!texture || texture.isCube || !texture.isReady()) continue;
        const pixels = await texture.readPixels(0, 0, null, true, false, 0, 0, 1, 1);
        samples.push({ actorId: actor.id, name: texture.name, size: texture.getSize(),
          pixel: pixels ? Array.from(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)) : null });
      }
      return samples;
    },
    sceneVisuals: () => {
      const sync = engineRef.current?.editor?.sync;
      const actors = sceneRef.current?.actors ?? [];
      if (!sync) return [];
      return actors.flatMap((actor) => {
        const visual = sync.visualMeshesForActor(actor.id)[0];
        if (!visual) return [];
        visual.computeWorldMatrix(true);
        const position = visual.getAbsolutePosition();
        return [
          {
            ...materialViewportTestSnapshot(visual),
            actorId: actor.id,
            position: [position.x, position.y, position.z],
            materialName: visual.material?.name ?? null,
          },
        ];
      });
    },
    activeSceneMeshPosition: () => {
      const actorId = sceneRef.current?.actors[0]?.id;
      if (!actorId) return null;
      const mesh = engineRef.current?.editor?.sync.meshForActor(actorId);
      if (!mesh) return null;
      return [mesh.position.x, mesh.position.y, mesh.position.z];
    },
    // Where the actor's mesh centre falls in the canvas, as 0-1 fractions of its width and height
    // (top-left origin), for a test to tap it.
    actorCanvasFraction: (actorId) => {
      const mesh = engineRef.current?.editor?.sync.meshForActor(actorId);
      const camera = mesh?.getScene().activeCamera;
      if (!mesh || !camera) return null;
      mesh.computeWorldMatrix(true);
      const ndc = Vector3.TransformCoordinates(
        mesh.getBoundingInfo().boundingBox.centerWorld,
        camera.getViewMatrix().multiply(camera.getProjectionMatrix()),
      );
      return { x: (ndc.x + 1) / 2, y: (1 - ndc.y) / 2 };
    },
    hardwareScalingLevel: () => engineRef.current?.scaling.getLevel() ?? null,
    postProcessPassCount: () =>
      engineRef.current?.postProcessPassCount() ?? null,
    /**
     * Simulate a finished gizmo drag: mutate the live Babylon mesh, then
     * commit through the same path as onGizmoDragEnd (not a document-only nudge).
     */
    commitGizmoNudge: async () => {
      const handle = engineRef.current;
      const current = sceneRef.current;
      const actorId = current?.actors[0]?.id;
      if (!handle?.editor || !current || !actorId) return false;
      const mesh = handle.editor.sync.meshForActor(actorId);
      if (!mesh) return false;
      handle.editor.setSelectedActors([actorId]);
      mesh.position.x += 1.5;
      dragStartSceneRef.current = current;
      commitGizmoTransform();
      return true;
    },
    commitMultiSelectGizmoNudge: async () => {
      const handle = engineRef.current;
      const current = sceneRef.current;
      if (!handle?.editor || !current || current.actors.length < 2) {
        return false;
      }
      const ids = current.actors
        .filter((actor) => !actor.locked)
        .map((actor) => actor.id);
      handle.editor.setSelectedActors(ids);
      const attached = handle.editor.gizmos.attachedMesh();
      if (!attached) return false;
      const parentIdOf = (id: string) =>
        current.actors.find((actor) => actor.id === id)?.parentId ?? null;
      const followers = selectionGizmoRoots(ids, parentIdOf)
        .map((id) => handle.editor!.sync.meshForActor(id))
        .filter(
          (mesh): mesh is NonNullable<typeof mesh> =>
            mesh !== null && mesh !== attached,
        );
      const drag = beginGizmoMultiSelectDrag(attached, followers);
      attached.position.x += 1.5;
      if (drag) applyGizmoMultiSelectDrag(drag, attached);
      dragStartSceneRef.current = current;
      commitGizmoTransform();
      return true;
    },
  };

  return () => {
    for (const cancel of measurements) cancel();
    unsubscribeSettings();
    releaseFrameHold?.();
    delete host.__hapticViewportTest;
  };
}

/**
 * Publishes `handle`'s render diagnostics on `panel.dataset.renderDiagnostics`
 * after each frame this view presents, and returns the removal. The panel
 * publishes only when a test build opts in with `?renderDiagnostics=1`.
 */
export function publishViewportRenderDiagnostics({
  panel,
  canvas,
  handle,
  engineRef,
  requestedRenderSettingsKey,
}: {
  panel: HTMLDivElement;
  canvas: HTMLCanvasElement;
  handle: EngineHandle;
  engineRef: RefObject<EngineHandle | null>;
  requestedRenderSettingsKey: string;
}): () => void {
  let lastFrame = -1;
  let lastAt = -Infinity;
  const publish = () => {
    const frame = handle.scheduler.stats().renderedFrames;
    const now = performance.now();
    if (engineRef.current !== handle || handle.scene.isDisposed ||
      frame <= 0 || frame === lastFrame || now - lastAt < 250) return;
    const rect = canvas.getBoundingClientRect();
    panel.dataset.renderDiagnostics = JSON.stringify({
      frame, capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent, devicePixelRatio: window.devicePixelRatio,
      canvas: { width: canvas.width, height: canvas.height, cssWidth: rect.width, cssHeight: rect.height },
      requested: JSON.parse(requestedRenderSettingsKey),
      render: handle.renderDiagnostics(),
    });
    lastFrame = frame;
    lastAt = now;
  };
  // sceneReady follows this view's presented first frame, not a sibling's
  // shared-Engine notification. Later captures require its own frame count.
  publish();
  const observer = handle.engine.onEndFrameObservable.add(publish);
  return () => {
    handle.engine.onEndFrameObservable.remove(observer);
    delete panel.dataset.renderDiagnostics;
  };
}
