import type { AbstractEngine } from "@babylonjs/core";
import { managedRenderReservations } from "./managed-render-resources";

// Lighting callers share the generic Engine ledger; this module re-exports its
// limit/shadow helpers and a lighting view of its reservations. No second
// ceiling or duplicate reservations.
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
