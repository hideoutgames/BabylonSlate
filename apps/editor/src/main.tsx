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
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
