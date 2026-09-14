import type { AbstractEngine } from "@babylonjs/core";

/** Conservative managed rendering ceiling, not measured/free GPU memory. */
export const MANAGED_RENDER_BYTE_LIMIT = 512 * 1024 ** 2;
export type ManagedRenderCategory =
  "cluster" | "sceneColor" | "geometry" | "depth" | "postprocess";
export type ManagedRenderResource = {
  handle: object;
  bytes: number;
  category: ManagedRenderCategory;
};
const categories: readonly ManagedRenderCategory[] = [
  "cluster",
  "sceneColor",
  "geometry",
  "depth",
  "postprocess",
];
type ResourceEntry = {
  bytes: number;
  references: number;
  categories: Map<ManagedRenderCategory, number>;
};
export type ManagedRenderLease = {
  /** Adopt actual unique allocations only after construction succeeds. */
  commit(resources: readonly ManagedRenderResource[]): void;
  /** Call only after owned allocation cleanup has completed. Idempotent. */
  release(): void;
};
type Ledger = {
  limit: number;
  shadowBytes: number;
  resourceBytes: number;
  pendingBytes: number;
  shadows: Map<object, number>;
  resources: Map<object, ResourceEntry>;
};
const ledgers = new WeakMap<AbstractEngine, Ledger>();

function ledger(engine: AbstractEngine): Ledger {
  let value = ledgers.get(engine);
  if (!value) {
    value = {
      limit: MANAGED_RENDER_BYTE_LIMIT,
      shadowBytes: 0,
      resourceBytes: 0,
      pendingBytes: 0,
      shadows: new Map(),
      resources: new Map(),
    };
    ledgers.set(engine, value);
    // Restoration rebuilds owners independently. Keep reservations until each
    // owner disposes its old handles; clearing globally would over-admit siblings.
    engine.onDisposeObservable.addOnce(() => ledgers.delete(engine));
  }
  return value;
}

export function managedRenderReservations(engine: AbstractEngine) {
  const value = ledger(engine);
  const categoryBytes = {
    cluster: 0,
    sceneColor: 0,
    geometry: 0,
    depth: 0,
    postprocess: 0,
  };
  let sharedBytes = 0;
  for (const resource of value.resources.values()) {
    if (resource.categories.size > 1) sharedBytes += resource.bytes;
    else
      categoryBytes[resource.categories.keys().next().value!] += resource.bytes;
  }
  return {
    limit: value.limit,
    shadowBytes: value.shadowBytes,
    categoryBytes,
    sharedBytes,
    resourceBytes: value.resourceBytes,
    pendingBytes: value.pendingBytes,
    reservedBytes: value.shadowBytes + value.resourceBytes + value.pendingBytes,
  };
}

export function availableManagedRenderBytes(engine: AbstractEngine): number {
  const value = ledger(engine);
  return Math.max(
    0,
    value.limit - value.shadowBytes - value.resourceBytes - value.pendingBytes,
  );
}

/** Internal lower ceiling for constrained clients/proofs; can never raise policy. */
export function limitManagedRenderBytes(
  engine: AbstractEngine,
  bytes: number,
): void {
  const value = ledger(engine);
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes > value.limit ||
    bytes < value.shadowBytes + value.resourceBytes + value.pendingBytes
  )
    throw new Error(
      "Managed rendering limit must decrease without revoking live reservations.",
    );
  value.limit = bytes;
}

/** Existing shadow admission releases incompatible maps before replacing this cost. */
export function reserveManagedShadowBytes(
  engine: AbstractEngine,
  owner: object,
  bytes: number,
): void {
  const value = ledger(engine);
  const previous = value.shadows.get(owner) ?? 0;
  if (previous === bytes) return;
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 0 ||
    bytes - previous > availableManagedRenderBytes(engine)
  )
    throw new Error(
      "Shadow allocation exceeds the shared managed rendering reservation.",
    );
  value.shadowBytes += bytes - previous;
  if (bytes) value.shadows.set(owner, bytes);
  else value.shadows.delete(owner);
}

/** Reserve the entire replacement peak while the previous lease remains live. */
export function beginManagedRenderAllocation(
  engine: AbstractEngine,
  bytes: number,
): ManagedRenderLease | undefined {
  const value = ledger(engine);
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new Error(
      "Managed rendering allocation requires a positive byte count.",
    );
  if (bytes > availableManagedRenderBytes(engine)) return undefined;
  value.pendingBytes += bytes;
  let pending = true;
  let released = false;
  let owned:
    | Map<object, { bytes: number; categories: Set<ManagedRenderCategory> }>
    | undefined;
  return {
    commit(resources) {
      if (released || !pending)
        throw new Error("Managed rendering allocation is no longer pending.");
      const unique = new Map<
        object,
        { bytes: number; categories: Set<ManagedRenderCategory> }
      >();
      for (const resource of resources) {
        if (
          !resource.handle ||
          typeof resource.handle !== "object" ||
          !Number.isSafeInteger(resource.bytes) ||
          resource.bytes <= 0 ||
          !categories.includes(resource.category)
        )
          throw new Error("Invalid managed rendering resource size.");
        const known =
          unique.get(resource.handle)?.bytes ??
          value.resources.get(resource.handle)?.bytes;
        if (known !== undefined && known !== resource.bytes)
          throw new Error(
            "Shared managed rendering handle has inconsistent sizes.",
          );
        const entry = unique.get(resource.handle) ?? {
          bytes: resource.bytes,
          categories: new Set<ManagedRenderCategory>(),
        };
        entry.categories.add(resource.category);
        unique.set(resource.handle, entry);
      }
      const actual = [...unique.values()].reduce(
        (sum, resource) => sum + resource.bytes,
        0,
      );
      if (actual > bytes || actual === 0)
        throw new Error(
          "Actual managed rendering allocation exceeds its reserved peak.",
        );
      for (const [handle, resource] of unique) {
        let current = value.resources.get(handle);
        if (current) current.references++;
        else {
          current = {
            bytes: resource.bytes,
            references: 1,
            categories: new Map(),
          };
          value.resources.set(handle, current);
          value.resourceBytes += resource.bytes;
        }
        for (const category of resource.categories)
          current.categories.set(
            category,
            (current.categories.get(category) ?? 0) + 1,
          );
      }
      owned = unique;
      pending = false;
      value.pendingBytes -= bytes;
    },
    release() {
      if (released) return;
      released = true;
      if (pending) value.pendingBytes -= bytes;
      for (const [handle, resource] of owned ?? []) {
        const current = value.resources.get(handle)!;
        for (const category of resource.categories) {
          const remaining = current.categories.get(category)! - 1;
          if (remaining) current.categories.set(category, remaining);
          else current.categories.delete(category);
        }
        if (--current.references === 0) {
          value.resourceBytes -= current.bytes;
          value.resources.delete(handle);
        }
      }
    },
  };
}
