import { sceneRenderingPipeline } from "./scene-rendering-pipeline";
import { readEngineDrawCalls } from "./draw-calls";
import { managedRenderReservations } from "./managed-render-resources";
import type { FramePressureSample } from "./hardware-scaling";
import type { ResolvedRenderingPipeline } from "@haptic/core";
import {
  type AbstractEngine,
  type Scene,
} from "@babylonjs/core";
import { findSceneShadowController, shadowLightDiagnostics } from "./shadow-controller";
import { effectiveShadowSettings } from "@haptic/core";
import { resolveSceneRenderingQuality, sceneEffectsQualityLimits, sceneRenderingSettings } from "./render-settings";
import { sceneViewRenderSize } from "./scene-output-scale";
import { sceneLightingLimits } from "./scene-lighting";
import { autoLodDiagnostics, liveMeshCount } from "./model-lod";
import { sceneOcclusionDiagnostics } from "./view-occlusion";
import type { RenderScheduler } from "./render-scheduler";
import type { FirstDrawStats } from "./first-draw-stats";
import type { GpuBusyStats } from "./gpu-busy-probe";

import { engineGpuTimingUnavailableReason, readEngineGpuTiming } from "./engine-gpu-timing";
import { deviceProfile, deviceTextureLimits } from "./device-profile";
export type GpuAttribution = "view" | "shared-engine" | "unavailable";

export type RenderDiagnostics = {
  /** Play: Effects first drawn since its world load presented (`first-draw-stats.ts`); null elsewhere and on WebGPU. */
  firstDraws?: FirstDrawStats | null;
  /**
   * A compact fingerprint of the effective settings the Feature Test Check's Breakdown steps change (`field: value`):
   * shadows, device-clamped water refraction, reflections and shading detail, post-processing tier flags and whether
   * post-processing runs, every-frame captures, resolution scale. A step that changes more than its own fields shows.
   */
  settings?: Record<string, string>;
  /**
   * GPU-busy time per Engine frame while the `gpubusy` debug command measures (`gpu-busy-probe.ts`); null when it has
   * not measured a frame or the Engine has no fences.
   */
  gpuBusy?: GpuBusyStats | null;
  /** View-owned draw/copy counts. A held draw never replaces the visible bitmap.
   * Phase timing is enabled by requesting diagnostics, independently of GPU timers. */
  presentation?: {
    attempted: number; drawn: number; copied: number; held: number;
    preparationMs: number; copyMs: number;
    contextLosses: number; contextRestorations: number;
    /** The view shows the Engine canvas itself (sole enabled view) instead of a copy. */
    direct?: boolean;
  };
  rendererWork?: {
    graphBuilds: number; shadowAdmissions: number; shadowAdmissionMs: number; strictReadinessChecks: number;
    /** Outline-task-only probes after a membership or style change. */
    outlineReadinessChecks: number;
  };
  frameAdmission?: ReturnType<RenderScheduler["gateState"]> & {
    worldLoading: boolean;
    pendingPresentations: number;
    registeredViewEnabled: boolean | null;
    registeredViewRequestedEnabled: boolean | null;
    rttPresenting: boolean;
    contextLost: boolean;
  };
  /** Textures the Engine holds and their estimated GPU bytes (`estimateTextureMemory`). */
  textureMemory?: { bytes: number; textures: number };
  /** While the world loads: the first frame's attempts. */
  worldLoad?: {
    presentation: { ready: boolean; draws: number; rendered: boolean; gpuPending: boolean; copied: boolean } | null;
  } | null;
  engineLoop?: {
    frameId: number;
    activeLoops: number;
    ownsLoop: boolean;
    frameHandler: number;
    disposed: boolean;
    contextLost: boolean;
    windowIsBackground: boolean;
    renderEvenInBackground: boolean;
    skipFrameRender: boolean;
    maxFPS: number | null;
    customRequester: boolean;
    sourceSize: [number, number] | null;
    now: number;
  };
  cpuMs: number;
  gpuMs: number | null;
  gpuStatus: "available" | "pending" | "unsupported";
  /**
   * Last per-view pressure sample feeding the dynamic scaling valve (null
   * before the first presented frame). `gpuMs` there is only attributed when
   * this view is the Engine's sole rendering view.
   */
  pressure: FramePressureSample | null;
  /** Why `gpuMs` is this view's own cost, shared with siblings, or missing. */
  gpuAttribution: GpuAttribution;
  /** Actual drawing-buffer dimensions after render scale. */
  width: number;
  height: number;
  /** Inverse render scale. Do not apply this again to the buffer dimensions. */
  scalingLevel: number;
  samples: number;
  shadowPasses: number;
  shadowMapBytes: number;
  shadowDrawCalls: number;
  shadowTriangles: number;
  readbackMs: number | null;
  shadowLights: ReturnType<typeof shadowLightDiagnostics>;
  qualityLimits: string[];
  pipeline: ResolvedRenderingPipeline;
  /**
   * Graphics API and adapter identity reported by the Engine itself, so a
   * diagnostics capture always names the real adapter and cannot be mistaken
   * for device qualification.
   */
  adapter: {
    api: "webgpu" | "webgl2";
    vendor: string | null;
    renderer: string | null;
    version: string | null;
  };
  /** Last rendered frame's Babylon draw-call count (`_drawCalls.current`). */
  drawCalls: number;
  /** Visible automatic-LOD meshes, how many draw a simplified level, and the triangles that saves. */
  autoLod: ReturnType<typeof autoLodDiagnostics>;
  /** The world view's last frame culled by occlusion (meshes tested and culled, occluders, their triangles, ms); null while it does not cull. */
  occlusion: { tested: number; culled: number; occluders: number; triangles: number; ms: number } | null;
  /** Live scene resource counts; cachedTextures is the Engine texture cache. */
  resources: {
    meshes: number;
    materials: number;
    textures: number;
    cachedTextures: number;
  };
  /** Accounted managed GPU reservations for the owning Engine. */
  gpuReservations: ReturnType<typeof managedRenderReservations>;
};

export function createRenderDiagnostics(
  scene: Scene,
  cpuMs: () => number,
  readbackMs: () => number | null = () => null,
  pressure: () => { sample: FramePressureSample | null; gpuAttribution: GpuAttribution } = () => ({
    sample: null,
    gpuAttribution: "unavailable",
  }),
): () => RenderDiagnostics {
  const engine = scene.getEngine();
  // Stats never activates a new query; it can consume an existing renderer or
  // explicit profiler lease. Profiling has its own fresh-query delivery stream.
  const supported = engineGpuTimingUnavailableReason(engine) === null;
  return () => {
    const gpuMs = readEngineGpuTiming(engine);
    const available = gpuMs !== null;
    const target = scene.activeCamera?.outputRenderTarget;
    const size = target?.getSize();
    // Reading must not install a shadow owner on a Scene that has none.
    const shadows = findSceneShadowController(scene);
    const metrics = shadows?.metrics() ?? { passes: 0, bytes: 0 };
    const state = sceneRenderingSettings(scene);
    const pipeline = sceneRenderingPipeline(scene);
    const { sample, gpuAttribution } = pressure();
    return {
      cpuMs: cpuMs(),
      pipeline,
      readbackMs: readbackMs(),
      shadowDrawCalls: shadows?.shadowDrawCalls() ?? 0,
      shadowTriangles: shadows?.shadowTriangles() ?? 0,
      gpuMs,
      gpuStatus: available
        ? "available"
        : supported
          ? "pending"
          : "unsupported",
      pressure: sample,
      gpuAttribution,
      // The world's render size: its output target's, or the backbuffer at the Scene's output scale.
      width: size?.width ?? sceneViewRenderSize(scene, null).width,
      height: size?.height ?? sceneViewRenderSize(scene, null).height,
      scalingLevel: engine.getHardwareScalingLevel(),
      samples: target?.samples ?? 1,
      shadowPasses: metrics.passes,
      shadowMapBytes: metrics.bytes,
      shadowLights: state.lightsDebug ? shadowLightDiagnostics(scene, shadows) : [],
      qualityLimits: [
        ...pipeline.limits,
        ...sceneLightingLimits(scene),
        ...effectiveShadowSettings(
          state.shadows,
          engine._features.supportCSM,
          state.mode,
          deviceProfile().shadowMapCap,
        ).limits,
        ...deviceTextureLimits(resolveSceneRenderingQuality(scene).textures.byteBudget),
        ...(shadows?.limits() ?? []),
        ...sceneEffectsQualityLimits(scene),
      ],
      adapter: engineAdapterInfo(engine),
      drawCalls: readEngineDrawCalls(engine),
      autoLod: autoLodDiagnostics(scene),
      occlusion: occlusionCounts(scene),
      resources: {
        meshes: liveMeshCount(scene),
        materials: scene.materials.length,
        textures: scene.textures.length,
        cachedTextures: engine.getLoadedTexturesCache().length,
      },
      gpuReservations: managedRenderReservations(engine),
    };
  };
}

export function engineAdapterInfo(engine: AbstractEngine) {
  const infoEngine = engine as {
    getInfo?: () => {
      vendor?: string;
      renderer?: string;
      version?: string;
    };
    getGlInfo?: () => {
      vendor?: string;
      renderer?: string;
      version?: string;
    };
  };
  const info = infoEngine.getInfo?.() ?? infoEngine.getGlInfo?.();
  return {
    api: (engine.isWebGPU ? "webgpu" : "webgl2") as "webgpu" | "webgl2",
    vendor: info?.vendor ?? null,
    renderer: info?.renderer ?? null,
    version: info?.version ?? null,
  };
}

export function lightsDebugText(diagnostics: RenderDiagnostics): string | null {
  if (!diagnostics.shadowLights.length) return null;
  return diagnostics.shadowLights
    .map(
      (light) =>
        `${light.name}: illumination ${light.illumination}; shadows ${light.status}${light.reason ? ` (${light.reason})` : ""}; ${light.mapSize}px / ${light.passes} passes${light.effectiveFilter ? ` / ${light.effectiveFilter}` : ""}${
          light.cascades.length ? `; cascades ${light.cascades.map((cascade) => `${cascade.end.toFixed(1)} m @ ${Math.round(cascade.texelsPerMetre)}/m`).join(", ")}` : ""}`,
    )
    .join("\n");
}

function occlusionCounts(scene: Scene): RenderDiagnostics["occlusion"] {
  const last = sceneOcclusionDiagnostics(scene);
  return last && { tested: last.tested, culled: last.culled, occluders: last.occluders, triangles: last.triangles, ms: last.ms };
}
