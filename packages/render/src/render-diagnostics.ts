import { readEngineDrawCalls } from "./draw-calls";
import { managedRenderReservations } from "./managed-render-resources";
import type { FramePressureSample } from "./hardware-scaling";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Scene } from "@babylonjs/core/scene";
import { liveShadowAtlasEdge } from "./shadow-atlas";
import { findSceneShadowController, shadowLightDiagnostics } from "./shadow-controller";
import { effectiveShadowSettings } from "@haptic/core";
import { resolveSceneRenderingQuality, sceneEffectsQualityLimits, sceneRenderingSettings } from "./render-settings";
import { sceneViewRenderSize } from "./scene-output-scale";
import { sceneLightingLimits } from "./scene-lighting";
import { autoLodDiagnostics, liveMeshCount } from "./model-lod";
import type { VisibilityView, VisibilityViewWork } from "./visibility-check";
import { sceneOcclusionDiagnostics } from "./view-occlusion";
import type { RenderScheduler } from "./render-scheduler";
import type { SceneReadinessDirtyReason } from "./scene-readiness-signal";
import type { FirstDrawStats, ProgramInventory } from "./first-draw-stats";
import type { GpuBusyStats } from "./gpu-busy-probe";
import type { FrameBackpressureStats } from "./frame-backpressure";
import type { DrawPassCounts } from "./draw-passes";
import type { OverlayBatchStats, OverlayBatchWork } from "./overlay-draw-batcher";
import type { LayerDrawableMeshWork } from "./layer-drawable-meshes";
import type { RetainedShadowDiagnostics } from "./shadow-retained-casters";
import { existingSceneInstancePool, type InstancePoolDiagnostics } from "./instance-pool";

import { engineGpuTimingUnavailableReason, readEngineGpuTiming } from "./engine-gpu-timing";
import { deviceTextureLimits } from "./device-profile";
export type GpuAttribution = "view" | "shared-engine" | "unavailable";

export type RenderDiagnostics = {
  /** Play: Effects first drawn since its world load presented (`first-draw-stats.ts`); null elsewhere. */
  firstDraws?: FirstDrawStats | null;
  /**
   * The programs the view's Engine holds now, every view's among them: how many, how many it never drew, and the drawn
   * ones by the pass that first drew each (`programInventory`); null for an Engine whose draws are not tracked.
   */
  programs?: ProgramInventory | null;
  /**
   * A compact fingerprint of the effective settings the Feature Test Check's Breakdown and Profile steps change
   * (`field: value`): `qualitySettingsFingerprint` (shadows, their filter, Screen-Space Shadows and Reflection Shadows, device-clamped water,
   * post-processing tier values, resolution scale, occlusion culling), plus the scene pass's live MSAA samples, whether
   * post-processing runs, every-frame captures, the water parts `waterdebug` switched off (`water.debug`), the shadow parts `shadowdebug` switched off (`shadows.debug`), the Engine's
   * frames in flight and the live context's preserveDrawingBuffer. A step that changes more than its own fields shows.
   */
  settings?: Record<string, string>;
  /**
   * The view's last drawn frame's draw calls by what drew them (`draw-passes.ts`); they add up to that frame's
   * `drawCalls`. Absent where the view does not attribute them.
   */
  drawPasses?: DrawPassCounts;
  /**
   * The main-thread time, in ms, of the view's last timed frame by the pass running (`draw-passes.ts`), attributed as
   * `drawPasses` is; they add up to the attributed part of that frame's `cpuMs`. Reading diagnostics times the frames
   * from the next one on: all zero before a timed frame. Absent where the view does not attribute them.
   */
  drawPassMs?: DrawPassCounts;
  /**
   * The Scene Layers of the view's last drawn frame: the visuals they drew, in how many draws and batches, and why the
   * rest drew on their own (`OverlayBatchStats`); all zero where it drew none.
   */
  layerBatches?: OverlayBatchStats;
  /**
   * GPU-busy time per Engine frame while the `gpubusy` debug command measures (`gpu-busy-probe.ts`); null when it has
   * not measured a frame or the Engine has no fences.
   */
  gpuBusy?: GpuBusyStats | null;
  /** The Engine frame loop's GPU backpressure (`frame-backpressure.ts`): its `framesinflight` mode, frames queued, renders skipped. */
  frameBackpressure?: FrameBackpressureStats | null;
  /** View-owned draw/copy counts. A held draw never replaces the visible bitmap.
   * Phase timing is enabled by requesting diagnostics, independently of GPU timers. */
  presentation?: {
    attempted: number; drawn: number; copied: number; held: number;
    /**
     * `held` by why the world view held each frame (`held-frames.ts`): its draw's `reason` ("Scene is not ready to
     * render.", a FrameGraph reason) or a `HELD_FRAME_LABELS` label; at most
     * `MAX_HELD_FRAME_REASONS` keys, later reasons under "other".
     */
    heldReasons: Record<string, number>;
    preparationMs: number; copyMs: number;
    contextLosses: number; contextRestorations: number;
    /** The view shows the Engine canvas itself (sole enabled view) instead of a copy. */
    direct?: boolean;
  };
  rendererWork?: {
    graphBuilds: number; shadowAdmissions: number; shadowAdmissionMs: number; strictReadinessChecks: number;
    /** The time the strict readiness checks took: each walks the Scene's meshes to ask whether the view may draw. */
    readinessProbeMs: number;
    /** Outline-task-only probes after a membership or style change. */
    outlineReadinessChecks: number;
    /**
     * Why the strict checks ran, counted from the first reading on: each check counts once for every reason marked
     * since the last check that passed. Reasons never counted are absent.
     */
    readinessProbeReasons: Partial<Record<SceneReadinessDirtyReason, number>>;
    /** Strict checks with no reason marked, run only because a variant swap was still pending. */
    readinessSwapRechecks: number;
    /** Strict checks that found the scene not ready. */
    failedReadinessProbes: number;
    /** Strict checks that asked only the meshes the marked changes named, not every mesh of the Scene. */
    scopedReadinessProbes: number;
    /** Scoped checks a check of every mesh disagreed with, counted only while that verification is on. */
    scopedReadinessMismatches: number;
    /**
     * Requests those checks of every mesh made for the Effect the asking sub-mesh already draws with in that pass: a
     * dirty flag that changed no variant, not a disagreement.
     */
    scopedReadinessIdleRequests: number;
    /**
     * Why the first of them disagreed (at most eight): whether the check of every mesh failed, compiled an Effect or
     * asked for one, after which marked reasons and how many scoped meshes, and the first Effects it asked for.
     */
    scopedReadinessMismatchCauses?: string[];
    /**
     * What the last strict check that failed since the first reading found unready, in the order it met them (at most
     * `MAX_READINESS_BLOCKERS`): a graph task, a mesh and its Material, a texture, a render target. Empty before one fails.
     */
    readinessBlockers: string[];
    /**
     * The shadow caster walks of the Scene, counted since its shadows began (`ShadowJournalDiagnostics`): how many
     * casters the change journal's walks visited of those they held, and what a full walk still found changed after
     * one (`heals`, every 32nd frame; `mismatches`, every frame while `verifyRenderChangeJournal` is on). Absent
     * without shadows.
     */
    shadowJournal?: {
      walks: number; casters: number; visited: number; moved: number; polledSources: number; polledMaterials: number;
      sourceChanges: number; cacheChecks: number; bufferChecks: number; localVisited: number; localScans: number;
      cascadeSkips: number; prepared: number; prepareScans: number; fullWalks: number; heals: number; mismatches: number; missedKinds: string[];
    };
    /**
     * The Scene's Mirror surfaces (`MirrorDiagnostics`): renders in which a visible surface's view had moved since its
     * draw, so it did not ask what its pass draws changed (`skipped`), and while `verifyMirrorContentPolls` is on, renders
     * an ask on every render would have decided otherwise (`mismatches`). Absent without Mirrors.
     */
    mirrorPolls?: { skipped: number; mismatches: number };
    /**
     * The Scene's Capture Only Actors capture lists made by the walk of every mesh (`checks`: the periodic ones, and
     * every list while `verifyCaptureActorLists` is on), and those the actors' meshes would have listed differently
     * (`mismatches`, which must stay 0). Absent before the first.
     */
    captureActorLists?: { checks: number; mismatches: number };
    /**
     * While `verifyMirrorFootprintCrops` is on: Mirror culls cropped to a surface's footprint that were also culled with
     * the whole mirrored frustum (`checks`), and meshes only those listed whose bounds reach the widened footprint
     * (`misses`, which must stay 0). It checks the crop's geometry for the reach it was given, not the Offset bound.
     * Absent without Mirrors.
     */
    mirrorCrop?: { checks: number; misses: number };
    /**
     * The view's strict outline cull (`SharedOutlineView.cullDiagnostics`): periodic checks of its kept candidate split
     * against a fresh one and those that replaced it (`splitChecks`, `healedSplits`), and while
     * `verifySharedOutlineCulls` is on, culls also made the full way (`checks`) and those that disagreed (`mismatches`,
     * which must stay 0). Absent without an outline view.
     */
    outlineCull?: { splitChecks: number; healedSplits: number; checks: number; mismatches: number };
    /**
     * Culls answered by the visibility index, per kind of view over every Scene (`VisibilityViewWork`): how many and
     * how long, the ones that also ran the full path (every 32nd, and all while `verifyVisibilityQueries` is on) and
     * how long that took, and the checks whose lists differed (`mismatches`, and `heals` for the periodic ones), which
     * must stay 0. Absent before the first.
     */
    visibility?: Partial<Record<VisibilityView, VisibilityViewWork>>;
    /**
     * The visibility index's rows since the page loaded: bounds read or read again (`reads`: a mesh whose bounds do
     * not change is read once, so reads per query is the share of meshes that moved) and tests answered by a mesh's
     * own `isInFrustum` (`deferred`). Present with `visibility`.
     */
    visibilityRows?: { reads: number; deferred: number };
  };
  /**
   * Each Scene Layer's own renderer work, in draw order (`SceneLayerCompositor.diagnostics`): what `rendererWork` is
   * for the world, with the layer's mesh count. A layer whose strict checks grow with every frame has something
   * marking its readiness each frame. Empty where the view composites no layer. `batching` is how its draw batcher kept
   * its work between frames, and what its verifier found (`OverlayBatchWork`); null where the layer does not batch.
   * `drawable` is how the list of its meshes that can draw was kept, and what its checks against a full filter found
   * and healed (`LayerDrawableMeshWork`: `mismatches` must stay 0).
   */
  layerWork?: Array<{
    layerId: string; meshes: number; work: NonNullable<RenderDiagnostics["rendererWork"]>; batching?: OverlayBatchWork | null;
    drawable?: LayerDrawableMeshWork | null;
  }>;
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
  /**
   * The Engine's backbuffer: Play with Scene Layers composites them at the device's pixels there, while the world
   * (`width` x `height`) draws at its own scale; absent where the view does not report it.
   */
  backbuffer?: { width: number; height: number };
  samples: number;
  shadowPasses: number;
  shadowMapBytes: number;
  shadowDrawCalls: number;
  shadowTriangles: number;
  /**
   * Shadow casters drawn from one shared buffer instead of one Babylon draw each: how many are retained, and since the
   * Scene's first map the draw calls made (`calls`) for the caster draws they stood for (`drawn`). Null where no
   * caster can be retained.
   */
  shadowRetained: RetainedShadowDiagnostics | null;
  readbackMs: number | null;
  shadowLights: ReturnType<typeof shadowLightDiagnostics>;
  /**
   * The Scene's shadow atlas edge in texels (0 without one) and each map it holds, by map size and tiles (a sun's
   * cascades, a point light's faces), largest first: what a shadow step changed.
   */
  shadowAtlas?: { edge: number; maps: { mapSize: number; passes: number }[] };
  qualityLimits: string[];
  /**
   * Adapter identity reported by the Engine itself, so a diagnostics capture
   * always names the real adapter and cannot be mistaken for device
   * qualification.
   */
  adapter: {
    vendor: string | null;
    renderer: string | null;
    version: string | null;
  };
  /** Last rendered frame's Babylon draw-call count (`_drawCalls.current`). */
  drawCalls: number;
  /** Visible automatic-LOD meshes, how many draw a simplified level, and the triangles that saves. */
  autoLod: ReturnType<typeof autoLodDiagnostics>;
  /** The Scene's instance pool (`SceneInstancePool.diagnostics`): groups, retained groups, pooled members and re-keys; null without one. */
  instancePool: InstancePoolDiagnostics | null;
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
    const { sample, gpuAttribution } = pressure();
    return {
      cpuMs: cpuMs(),
      readbackMs: readbackMs(),
      shadowDrawCalls: shadows?.shadowDrawCalls() ?? 0,
      shadowTriangles: shadows?.shadowTriangles() ?? 0,
      shadowRetained: shadows?.retainedCasters() ?? null,
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
      shadowAtlas: {
        edge: liveShadowAtlasEdge(scene),
        maps: shadows
          ? shadowLightDiagnostics(scene, shadows).filter((row) => row.mapSize > 0)
            .map((row) => ({ mapSize: row.mapSize, passes: row.passes })).sort((a, b) => b.mapSize - a.mapSize || b.passes - a.passes)
          : [],
      },
      qualityLimits: [
        ...sceneLightingLimits(scene),
        ...effectiveShadowSettings(
          state.shadows,
          engine._features.supportCSM,
          state.mode,
        ).limits,
        ...deviceTextureLimits(resolveSceneRenderingQuality(scene).textures.byteBudget),
        ...(shadows?.limits() ?? []),
        ...sceneEffectsQualityLimits(scene),
      ],
      adapter: engineAdapterInfo(engine),
      drawCalls: readEngineDrawCalls(engine),
      autoLod: autoLodDiagnostics(scene),
      instancePool: existingSceneInstancePool(scene)?.diagnostics() ?? null,
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
