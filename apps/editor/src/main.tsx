import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@haptic/ui/styles/globals.css";
import "@haptic/editor-kit/styles/context-menu.css";
import {
  defaultCompactMode,
  initializeCapacitorAudioLifecycle,
  initializeCapacitorLifecycle,
  isTestModeEnabled,
} from "@haptic/vfs";
import { setTouchUi } from "@haptic/editor-kit";
import { installDirectViewReadSync } from "@haptic/render";
import App from "./App";
import { installPreloadErrorReload } from "./lib/preload-error-reload";

initializeCapacitorLifecycle();
initializeCapacitorAudioLifecycle();
installPreloadErrorReload();
// First paint uses the platform's Compact Mode; settings may change it once loaded.
setTouchUi(!defaultCompactMode());

if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("latticeDeformerCost")) {
  void import("./testing/lattice-deformer-cost").then(({ runLatticeDeformerCost }) => Object.assign(window, { __latticeDeformerCost: runLatticeDeformerCost }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("latticeDeformerProof")) {
  void import("./testing/lattice-deformer-proof").then(({ runLatticeDeformerProof }) => Object.assign(window, { __latticeDeformerProof: runLatticeDeformerProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("gpuPickProof")) {
  void import("./testing/gpu-pick-proof").then(({ runGpuPickProof }) => Object.assign(window, { __gpuPickProof: runGpuPickProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("fsrUpscalingProof")) {
  void import("./testing/fsr-upscaling-proof").then(({ runFsrUpscalingProof }) => Object.assign(window, { __fsrUpscalingProof: runFsrUpscalingProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("renderTargetProof")) {
  void import("./testing/render-target-proof").then(({ runRenderTargetProof }) => Object.assign(window, { __renderTargetProof: runRenderTargetProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("renderTargetQualityProof")) {
  void import("./testing/render-target-quality-proof").then(({ runRenderTargetQualityProof, runRenderTargetQualityCost, runRenderTargetShadowProof }) =>
    Object.assign(window, {
      __renderTargetQualityProof: runRenderTargetQualityProof, __renderTargetQualityCost: runRenderTargetQualityCost,
      __renderTargetShadowProof: runRenderTargetShadowProof,
    }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("spatialEffectsProof")) {
  void import("./testing/spatial-effects-proof").then(({ runSpatialEffectsProof }) => Object.assign(window, { __spatialEffectsProof: runSpatialEffectsProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("colorGradingProof")) {
  void import("./testing/color-grading-proof").then(({ runColorGradingProof, runDisplayColorProof }) => Object.assign(window, { __colorGradingProof: runColorGradingProof, __displayColorProof: runDisplayColorProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("temporalAntiAliasingProof")) {
  void import("./testing/temporal-anti-aliasing-proof").then(({ runTemporalAntiAliasingProof }) => Object.assign(window, { __temporalAntiAliasingProof: runTemporalAntiAliasingProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("hapticLightProof")) {
  void import("./testing/haptic-light-proof").then(({ runHapticLightProof }) => Object.assign(window, { __hapticLightProof: runHapticLightProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("unlitParityProof")) {
  void import("./testing/unlit-parity-proof").then(({ runUnlitParityProof }) => Object.assign(window, { __unlitParityProof: runUnlitParityProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("lightLoopProof")) {
  void import("./testing/light-loop-proof").then(({ runLightCullingParity, runLightLoopProof }) =>
    Object.assign(window, { __lightLoopProof: runLightLoopProof, __lightCullingParity: runLightCullingParity }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("hapticContactShadowProof")) {
  void import("./testing/haptic-contact-shadow-proof").then(({ runHapticContactShadowProof }) => Object.assign(window, { __hapticContactShadowProof: runHapticContactShadowProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("cascadeShimmerProof")) {
  void import("./testing/cascade-shimmer-proof").then(({ runCascadeShimmerProof }) => Object.assign(window, { __cascadeShimmerProof: runCascadeShimmerProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("occlusionCullingProof")) {
  void import("./testing/occlusion-culling-proof").then(({ runOcclusionCullingProof }) => Object.assign(window, { __occlusionCullingProof: runOcclusionCullingProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("instancingParityProof")) {
  void import("./testing/instancing-parity-proof").then(({ runInstancingParityProof }) => Object.assign(window, { __instancingParityProof: runInstancingParityProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("hapticScreenShadowsProof")) {
  void import("./testing/haptic-screen-shadows-proof").then(({ runHapticScreenShadowsProof }) => Object.assign(window, { __hapticScreenShadowsProof: runHapticScreenShadowsProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("waterCutProof")) {
  void import("./testing/water-cut-proof").then(({ runWaterCutProof }) => Object.assign(window, { __waterCutProof: runWaterCutProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("waterSeamProof")) {
  void import("./testing/water-seam-proof").then(({ runWaterSeamProof }) => Object.assign(window, { __waterSeamProof: runWaterSeamProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("waterReflectionProof")) {
  void import("./testing/water-reflection-proof").then(({ runWaterReflectionProof }) => Object.assign(window, { __waterReflectionProof: runWaterReflectionProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("waterTemplateProof")) {
  void import("./testing/water-template-proof").then(({ runWaterTemplateProof }) => Object.assign(window, { __waterTemplateProof: runWaterTemplateProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("variantSwapProof")) {
  void import("./testing/variant-swap-proof").then(({ runVariantSwapProof }) => Object.assign(window, { __hapticVariantSwapProof: runVariantSwapProof }));
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("sharedOutlineProof")
) {
  void import("./testing/shared-outline-proof").then(({ runSharedOutlineProof }) => {
    Object.assign(window, { __hapticSharedOutlineProof: runSharedOutlineProof });
  });
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("framegraphForwardProof")
) {
  void import("./testing/framegraph-forward-proof").then(
    ({ runFrameGraphForwardProof }) => {
      Object.assign(window, {
        __hapticFrameGraphForwardProof: runFrameGraphForwardProof,
      });
    },
  );
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("webgpuProof")
) {
  void import("./testing/webgpu-proof").then(({ runWebGpuProof }) => {
    Object.assign(window, { __hapticWebGpuProof: runWebGpuProof });
  });
} else {
  // Pixel probes read view canvases; a directly presented view writes its image into its canvas first.
  if (isTestModeEnabled()) installDirectViewReadSync();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
