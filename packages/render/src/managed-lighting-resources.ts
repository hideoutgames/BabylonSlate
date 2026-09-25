import type { AbstractEngine } from "@babylonjs/core";
import { managedRenderReservations } from "./managed-render-resources";

// Existing lighting callers share the generic Engine ledger and keep their
// narrower category policy. No second ceiling or duplicate reservations.
export {
  availableManagedRenderBytes as availableManagedLightingBytes,
  limitManagedRenderBytes as limitManagedLightingBytes,
  reserveManagedShadowBytes,
} from "./managed-render-resources";
export type ManagedLightingResource = { handle: object; bytes: number };

export function managedLightingReservations(engine: AbstractEngine) {
  const value = managedRenderReservations(engine);
  return {
    limit: value.limit,
    shadowBytes: value.shadowBytes,
    clusterBytes: value.categoryBytes.cluster,
    areaLightBytes: value.categoryBytes.areaLight,
    pendingBytes: value.pendingBytes,
    reservedBytes: value.reservedBytes,
  };
}
