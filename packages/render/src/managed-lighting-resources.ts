import type { AbstractEngine } from "@babylonjs/core";
import {
  beginManagedRenderAllocation,
  managedRenderReservations,
} from "./managed-render-resources";

// Existing lighting callers share the generic Engine ledger and keep their
// narrower category policy. No second ceiling or duplicate reservations.
export {
  MANAGED_RENDER_BYTE_LIMIT as MANAGED_LIGHTING_BYTE_LIMIT,
  availableManagedRenderBytes as availableManagedLightingBytes,
  limitManagedRenderBytes as limitManagedLightingBytes,
  reserveManagedShadowBytes,
} from "./managed-render-resources";
export type ManagedLightingResource = { handle: object; bytes: number };
export type ManagedLightingLease = {
  commit(resources: readonly ManagedLightingResource[]): void;
  /** Release only after owned allocation cleanup completes. */
  release(): void;
};

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

export function beginManagedLightingAllocation(
  engine: AbstractEngine,
  bytes: number,
): ManagedLightingLease | undefined {
  const lease = beginManagedRenderAllocation(engine, bytes);
  return (
    lease && {
      commit: (resources) =>
        lease.commit(
          resources.map((resource) => ({ ...resource, category: "cluster" })),
        ),
      release: () => lease.release(),
    }
  );
}
