import { clusteredLocalContributionCount } from "./clustered-light-policy";
import { sceneRenderPathStatus } from "./scene-render-path";
import { readEngineDrawCalls } from "./draw-calls";
import { managedRenderReservations } from "./managed-render-resources";
import type { FramePressureSample } from "./hardware-scaling";
import type { ResolvedRenderingPipeline } from "@babylonslate/core";
import {
  type AbstractEngine,
  type Scene,
} from "@babylonjs/core";
import { findSceneShadowController, shadowLightDiagnostics } from "./shadow-controller";
import { effectiveShadowSettings } from "@babylonslate/core";
import { sceneRenderingSettings } from "./render-settings";
import { sceneLightingLimits } from "./scene-lighting";
import { autoLodDiagnostics, liveMeshCount } from "./model-lod";
import type { RenderScheduler } from "./render-scheduler";

import { engineGpuTimingUnavailableReason, readEngineGpuTiming } from "./engine-gpu-timing";
export type GpuAttribution = "view" | "shared-engine" | "unavailable";

export type RenderDiagnostics = {
  /** View-owned draw/copy counts. A held draw never replaces the visible bitmap.
   * Phase timing is enabled by requesting diagnostics, independently of GPU timers. */
  presentation?: {
    attempted: number; drawn: number; copied: number; held: number;
    preparationMs: number; copyMs: number;
    contextLosses: number; contextRestorations: number;
  };
  rendererWork?: {
    graphBuilds: number; shadowAdmissions: number; shadowAdmissionMs: number; strictReadinessChecks: number;
  };
  frameAdmission?: ReturnType<RenderScheduler["gateState"]> & {
    worldLoading: boolean;
    pendingPresentations: number;
    registeredViewEnabled: boolean | null;
    registeredViewRequestedEnabled: boolean | null;
    rttPresenting: boolean;
    contextLost: boolean;
  };
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
  clusteredLights: number;
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
    const pipeline = sceneRenderPathStatus(scene);
    const { sample, gpuAttribution } = pressure();
    return {
      cpuMs: cpuMs(),
      pipeline,
      clusteredLights: clusteredLocalContributionCount(scene),
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
      width: size?.width ?? engine.getRenderWidth(),
      height: size?.height ?? engine.getRenderHeight(),
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
        ).limits,
        ...(shadows?.limits() ?? []),
      ],
      adapter: engineAdapterInfo(engine),
      drawCalls: readEngineDrawCalls(engine),
      autoLod: autoLodDiagnostics(scene),
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
        `${light.name}: illumination ${light.illumination}; shadows ${light.status}${light.reason ? ` (${light.reason})` : ""}; ${light.mapSize}px / ${light.passes} passes${light.effectiveFilter ? ` / ${light.effectiveFilter}` : ""}`,
    )
    .join("\n");
}
