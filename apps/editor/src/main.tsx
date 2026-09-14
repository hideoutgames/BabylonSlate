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
