import { createContext, useContext } from "react";
import type { GpuBackend } from "@babylonslate/core";

export type ProjectRenderingStatus = {
  phase: "idle" | "preparing" | "initializing" | "ready" | "failed";
  requestedBackend: GpuBackend;
  effectiveBackend: "webgl2" | "webgpu" | null;
  fallbackReason?: string;
  deferredUntilStop: boolean;
};

export const ProjectRenderingContext = createContext<ProjectRenderingStatus | null>(null);
export function useProjectRenderingStatus() {
  return useContext(ProjectRenderingContext);
}
