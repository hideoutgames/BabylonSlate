import type { PhysicsBackend } from "./backend";
import type { PhysicsBackendOptions, PhysicsWorldKind, Vec3 } from "./types";
import { SoftwarePhysicsBackend } from "./software-backend";

export type CreatePhysicsBackendOptions = PhysicsBackendOptions & {
  /**
   * Force the deterministic software backend (no wasm). Used by unit tests
   * and as a fallback when a wasm engine fails to load.
   */
  preferSoftware?: boolean;
  /** Set false for Play so a failed engine load cannot change collision behavior. */
  allowSoftwareFallback?: boolean;
};

/** Tracks which heavy backends were dynamically imported (lazy-load tests). */
export const loadedBackendModules = {
  havok: false,
  rapier: false,
};

export function resetLoadedBackendModules(): void {
  loadedBackendModules.havok = false;
  loadedBackendModules.rapier = false;
}

/**
 * Lazy factory: only dynamic-imports the engine matching `options.kind`.
 * A 3D scene never downloads Rapier; a 2D scene never downloads Havok.
 */
export async function createPhysicsBackend(
  options: CreatePhysicsBackendOptions,
): Promise<PhysicsBackend> {
  if (options.preferSoftware) {
    return new SoftwarePhysicsBackend(options.kind, options.gravity);
  }

  if (options.kind === "3d") {
    try {
      const { HavokPhysicsBackend } = await import("./havok-backend");
      const backend = await HavokPhysicsBackend.create(options);
      loadedBackendModules.havok = true;
      return backend;
    } catch (error) {
      if (options.allowSoftwareFallback === false) throw error;
      console.warn(
        "[physics] Havok failed to load; falling back to software backend",
        error,
      );
      return new SoftwarePhysicsBackend("3d", options.gravity);
    }
  }

  try {
    const { Rapier2DPhysicsBackend } = await import("./rapier-backend");
    const backend = await Rapier2DPhysicsBackend.create(options);
    loadedBackendModules.rapier = true;
    return backend;
  } catch (error) {
    if (options.allowSoftwareFallback === false) throw error;
    console.warn(
      "[physics] Rapier2D failed to load; falling back to software backend",
      error,
    );
    return new SoftwarePhysicsBackend("2d", options.gravity);
  }
}

/**
 * Loads Rapier 2D once and returns a synchronous factory of independent native
 * 2D worlds, for callers that create worlds after loading (one per Scene Layer).
 * Never falls back to software.
 */
export async function loadRapier2DBackendFactory(): Promise<(gravity: Vec3) => PhysicsBackend> {
  const { Rapier2DPhysicsBackend } = await import("./rapier-backend");
  const factory = await Rapier2DPhysicsBackend.createFactory();
  loadedBackendModules.rapier = true;
  return factory;
}

export function createSoftwarePhysicsBackend(
  kind: PhysicsWorldKind,
  gravity = { x: 0, y: -9.81, z: 0 },
): PhysicsBackend {
  return new SoftwarePhysicsBackend(kind, gravity);
}
