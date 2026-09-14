import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@babylonslate/ui/styles/globals.css";
import "@babylonslate/editor-kit/styles/context-menu.css";
import {
  initializeCapacitorAudioLifecycle,
  initializeCapacitorLifecycle,
} from "@babylonslate/vfs";
import App from "./App";

const bakeProof = (import.meta as ImportMeta & { env: { VITE_TEST_MODE?: string } }).env.VITE_TEST_MODE === "true"
  && new URLSearchParams(location.search).has("bake-provider-proof");
if (bakeProof) {
  // Test builds exercise the real isolated provider without an active viewport.
  void import("@babylonslate/render/bake-provider-prototype").then((provider) => {
    Object.assign(globalThis, { __bakePrototype: provider });
  });
} else {
  initializeCapacitorLifecycle();
  initializeCapacitorAudioLifecycle();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
