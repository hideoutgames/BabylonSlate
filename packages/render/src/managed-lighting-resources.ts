import type { AbstractEngine } from "@babylonjs/core";

/** Conservative managed lighting ceiling, not measured/free GPU memory. */
export const MANAGED_LIGHTING_BYTE_LIMIT = 512 * 1024 ** 2;
export type ManagedLightingResource = { handle: object; bytes: number };
export type ManagedLightingLease = {
  /** Adopt actual unique allocations only after construction succeeds. */
  commit(resources: readonly ManagedLightingResource[]): void;
  /** Call only after owned allocation cleanup has completed. Idempotent. */
  release(): void;
};
type Ledger = {
  limit: number;
  shadowBytes: number;
  resourceBytes: number;
  pendingBytes: number;
  shadows: Map<object, number>;
  resources: Map<object, { bytes: number; references: number }>;
};
const ledgers = new WeakMap<AbstractEngine, Ledger>();

function ledger(engine: AbstractEngine): Ledger {
  let value = ledgers.get(engine);
  if (!value) {
    value = { limit: MANAGED_LIGHTING_BYTE_LIMIT, shadowBytes: 0,
      resourceBytes: 0, pendingBytes: 0, shadows: new Map(), resources: new Map() };
    ledgers.set(engine, value);
    // Restoration rebuilds owners independently. Keep reservations until each
    // owner disposes its old handles; clearing globally would over-admit siblings.
    engine.onDisposeObservable.addOnce(() => ledgers.delete(engine));
  }
  return value;
}

export function managedLightingReservations(engine: AbstractEngine) {
  const value = ledger(engine);
  return { limit: value.limit, shadowBytes: value.shadowBytes,
    clusterBytes: value.resourceBytes, pendingBytes: value.pendingBytes,
    reservedBytes: value.shadowBytes + value.resourceBytes + value.pendingBytes };
}

export function availableManagedLightingBytes(engine: AbstractEngine): number {
  const value = ledger(engine);
  return Math.max(0, value.limit - value.shadowBytes - value.resourceBytes - value.pendingBytes);
}

/** Internal lower ceiling for constrained clients/proofs; can never raise policy. */
export function limitManagedLightingBytes(engine: AbstractEngine, bytes: number): void {
  const value = ledger(engine);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > value.limit ||
      bytes < value.shadowBytes + value.resourceBytes + value.pendingBytes)
    throw new Error("Managed lighting limit must decrease without revoking live reservations.");
  value.limit = bytes;
}

/** Existing shadow admission releases incompatible maps before replacing this cost. */
export function reserveManagedShadowBytes(engine: AbstractEngine, owner: object, bytes: number): void {
  const value = ledger(engine);
  const previous = value.shadows.get(owner) ?? 0;
  if (previous === bytes) return;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes - previous > availableManagedLightingBytes(engine))
    throw new Error("Shadow allocation exceeds the shared managed lighting reservation.");
  value.shadowBytes += bytes - previous;
  if (bytes) value.shadows.set(owner, bytes);
  else value.shadows.delete(owner);
}

/** Reserve the entire replacement peak while the previous lease remains live. */
export function beginManagedLightingAllocation(engine: AbstractEngine, bytes: number): ManagedLightingLease | undefined {
  const value = ledger(engine);
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error("Managed lighting allocation requires a positive byte count.");
  if (bytes > availableManagedLightingBytes(engine)) return undefined;
  value.pendingBytes += bytes;
  let pending = true;
  let released = false;
  let owned: Map<object, number> | undefined;
  return {
    commit(resources) {
      if (released || !pending) throw new Error("Managed lighting allocation is no longer pending.");
      const unique = new Map<object, number>();
      for (const resource of resources) {
        if (!Number.isSafeInteger(resource.bytes) || resource.bytes <= 0)
          throw new Error("Invalid managed lighting resource size.");
        const known = unique.get(resource.handle) ?? value.resources.get(resource.handle)?.bytes;
        if (known !== undefined && known !== resource.bytes)
          throw new Error("Shared managed lighting handle has inconsistent sizes.");
        unique.set(resource.handle, resource.bytes);
      }
      const actual = [...unique.values()].reduce((sum, size) => sum + size, 0);
      if (actual > bytes || actual === 0)
        throw new Error("Actual managed lighting allocation exceeds its reserved peak.");
      for (const [handle, size] of unique) {
        const current = value.resources.get(handle);
        if (current) current.references++;
        else { value.resources.set(handle, { bytes: size, references: 1 }); value.resourceBytes += size; }
      }
      owned = unique;
      pending = false;
      value.pendingBytes -= bytes;
    },
    release() {
      if (released) return;
      released = true;
      if (pending) value.pendingBytes -= bytes;
      for (const handle of owned?.keys() ?? []) {
        const current = value.resources.get(handle)!;
        if (--current.references === 0) {
          value.resourceBytes -= current.bytes;
          value.resources.delete(handle);
        }
      }
    },
  };
}
