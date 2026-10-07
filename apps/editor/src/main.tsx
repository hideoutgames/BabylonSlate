import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@babylonslate/ui/styles/globals.css";
import "@babylonslate/editor-kit/styles/context-menu.css";
import {
  initializeCapacitorAudioLifecycle,
  initializeCapacitorLifecycle,
} from "@babylonslate/vfs";
import App from "./App";

initializeCapacitorLifecycle();
initializeCapacitorAudioLifecycle();

if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("latticeDeformerCost")) {
  void import("./testing/lattice-deformer-cost").then(({ runLatticeDeformerCost }) => Object.assign(window, { __latticeDeformerCost: runLatticeDeformerCost }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("latticeDeformerProof")) {
  void import("./testing/lattice-deformer-proof").then(({ runLatticeDeformerProof }) => Object.assign(window, { __latticeDeformerProof: runLatticeDeformerProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("gpuPickProof")) {
  void import("./testing/gpu-pick-proof").then(({ runGpuPickProof }) => Object.assign(window, { __gpuPickProof: runGpuPickProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("renderTargetProof")) {
  void import("./testing/render-target-proof").then(({ runRenderTargetProof }) => Object.assign(window, { __renderTargetProof: runRenderTargetProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("spatialEffectsProof")) {
  void import("./testing/spatial-effects-proof").then(({ runSpatialEffectsProof }) => Object.assign(window, { __spatialEffectsProof: runSpatialEffectsProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("colorGradingProof")) {
  void import("./testing/color-grading-proof").then(({ runColorGradingProof }) => Object.assign(window, { __colorGradingProof: runColorGradingProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("temporalAntiAliasingProof")) {
  void import("./testing/temporal-anti-aliasing-proof").then(({ runTemporalAntiAliasingProof }) => Object.assign(window, { __temporalAntiAliasingProof: runTemporalAntiAliasingProof }));
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("clusteredLightProof")
) {
  void import("./testing/clustered-light-proof").then(
    ({ runClusteredLightProof }) => {
      Object.assign(window, {
        __babylonslateClusteredLightProof: runClusteredLightProof,
      });
    },
  );
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("sharedOutlineProof")
) {
  void import("./testing/shared-outline-proof").then(({ runSharedOutlineProof }) => {
    Object.assign(window, { __babylonslateSharedOutlineProof: runSharedOutlineProof });
  });
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("framegraphForwardProof")
) {
  void import("./testing/framegraph-forward-proof").then(
    ({ runFrameGraphForwardProof }) => {
      Object.assign(window, {
        __babylonslateFrameGraphForwardProof: runFrameGraphForwardProof,
      });
    },
  );
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("webgpuProof")
) {
  void import("./testing/webgpu-proof").then(({ runWebGpuProof }) => {
    Object.assign(window, { __babylonslateWebGpuProof: runWebGpuProof });
  });
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
