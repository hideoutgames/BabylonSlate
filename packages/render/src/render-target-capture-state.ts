import type { Scene } from "@babylonjs/core";

/** Auxiliary camera swaps leave the main view's prepared graph unchanged. */
export const renderTargetCaptureDrawing = new WeakSet<Scene>();
