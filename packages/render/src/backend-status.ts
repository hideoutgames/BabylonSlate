import type { AbstractEngine } from "@babylonjs/core";
import type { GpuBackend } from "@babylonslate/core";

export interface EngineBackendStatus {
  requestedBackend: GpuBackend;
  effectiveBackend: "webgl2" | "webgpu";
  fallbackReason?: string;
}
const statuses = new WeakMap<AbstractEngine, EngineBackendStatus>();
/** Startup evidence belongs to the Engine; every view reads the same fallback reason. */
export function setEngineBackendStatus(engine: AbstractEngine, status: EngineBackendStatus): void {
  statuses.set(engine, Object.freeze({ ...status }));
}
export function engineBackendStatus(engine: AbstractEngine): Readonly<EngineBackendStatus> | undefined {
  return statuses.get(engine);
}
