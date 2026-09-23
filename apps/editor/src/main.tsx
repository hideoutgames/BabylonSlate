import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@babylonslate/ui/styles/globals.css";
import "@babylonslate/editor-kit/styles/context-menu.css";
import {
  initializeCapacitorAudioLifecycle,
  initializeCapacitorLifecycle,
} from "@babylonslate/vfs";
import App from "./App";
import { initSessionLiveness } from "./lib/session-liveness";

initializeCapacitorLifecycle();
initializeCapacitorAudioLifecycle();
initSessionLiveness();

if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("visualGenerationProof")) {
  void import("./testing/visual-generation-proof").then(({ runVisualGenerationProof }) => Object.assign(window, { __visualGenerationProof: runVisualGenerationProof }));
} else if (import.meta.env.VITE_TEST_MODE === "true" && new URLSearchParams(location.search).has("textureLeaseProof")) {
  void import("./testing/texture-lease-proof").then(({ runTextureLeaseProof }) => Object.assign(window, { __textureLeaseProof: runTextureLeaseProof }));
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("particleLifecycleProof")
) {
  void import("./testing/particle-lifecycle-proof").then(({ runParticleLifecycleProof }) => {
    Object.assign(window, { __babylonslateParticleLifecycleProof: runParticleLifecycleProof });
  });
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("scenePostProcessHostProof")
) {
  void import("./testing/scene-post-process-host-proof").then(({ createScenePostProcessHostProof }) => {
    Object.assign(window, { __babylonslateScenePostProcessHostProof: createScenePostProcessHostProof });
  });
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("scenePostProcessCoordinatorProof")
) {
  void import("./testing/scene-post-process-coordinator-proof").then(({ runScenePostProcessCoordinatorProof }) => {
    Object.assign(window, { __babylonslateScenePostProcessCoordinatorProof: runScenePostProcessCoordinatorProof });
  });
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("postProcessLifetimeProof")
) {
  void import("./testing/framegraph-post-process-lifetime-proof").then(({ runPostProcessLifetimeProof }) => {
    Object.assign(window, { __babylonslatePostProcessLifetimeProof: runPostProcessLifetimeProof });
  });
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("framegraphGeometryProof")
) {
  void import("./testing/framegraph-geometry-proof").then(({ runFrameGraphGeometryProof }) => {
    Object.assign(window, { __babylonslateFrameGraphGeometryProof: runFrameGraphGeometryProof });
  });
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
  new URLSearchParams(location.search).has("framegraphShadowProof")
) {
  void import("./testing/framegraph-shadow-proof").then(
    ({ runFrameGraphShadowProof }) => {
      Object.assign(window, {
        __babylonslateFrameGraphShadowProof: runFrameGraphShadowProof,
      });
    },
  );
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
  new URLSearchParams(location.search).has("framegraphProof")
) {
  void import("./testing/framegraph-post-process-proof").then(
    ({ runFrameGraphPostProcessProof }) => {
      Object.assign(window, {
        __babylonslateFrameGraphProof: runFrameGraphPostProcessProof,
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
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("celRenderModeProof")
) {
  void import("./testing/cel-render-mode-proof").then(
    ({ runCelRenderModeProof }) => {
      Object.assign(window, {
        __babylonslateCelRenderModeProof: runCelRenderModeProof,
      });
    },
  );
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("environmentWebgpuProof")
) {
  void import("./lib/environment-lighting-proof").then(
    ({ runEnvironmentIrradianceWebGpuProof }) => {
      Object.assign(window, {
        __babylonslateEnvironmentWebGpuProof:
          runEnvironmentIrradianceWebGpuProof,
      });
    },
  );
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("bake-provider-proof")
) {
  void import("@babylonslate/render/bake-provider-prototype").then((provider) => {
    Object.assign(globalThis, { __bakePrototype: provider });
  });
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("bakedRuntimeProof")
) {
  void import("./testing/baked-runtime-proof").then(({ runBakedRuntimeProof }) => {
    Object.assign(window, { __bakedRuntimeProof: runBakedRuntimeProof });
  });
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("bakedParityProof")
) {
  void import("./testing/baked-parity-proof").then(({ runBakedParityProof }) => {
    Object.assign(window, { __bakedParityProof: runBakedParityProof });
  });
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("bakedPlayerFixture")
) {
  void import("./testing/baked-player-fixture").then(({ runBakedPlayerFixture }) => {
    Object.assign(window, { __bakedPlayerFixture: runBakedPlayerFixture });
  });
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("sceneBakeProof")
) {
  void import("./testing/scene-bake-proof").then(({ runSceneBakeProof }) => {
    Object.assign(window, { __sceneBakeProof: runSceneBakeProof });
  });
} else if (
  import.meta.env.VITE_TEST_MODE === "true" &&
  new URLSearchParams(location.search).has("bakeUvProof")
) {
  void import("./testing/bake-uv-proof").then(
    ({ runBakeUvProof, runBakeUvProviderProof }) => {
      Object.assign(globalThis, {
        __bakeUvProof: runBakeUvProof,
        __bakeUvProviderProof: runBakeUvProviderProof,
      });
    },
  );
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
