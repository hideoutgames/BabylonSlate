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

if (
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
  new URLSearchParams(location.search).has("bake-provider-proof")
) {
  void import("@babylonslate/render/bake-provider-prototype").then((provider) => {
    Object.assign(globalThis, { __bakePrototype: provider });
  });
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
