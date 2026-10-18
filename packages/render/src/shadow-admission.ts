import type { AbstractEngine, Scene } from "@babylonjs/core";
import {
  availableManagedLightingBytes,
  reserveManagedShadowBytes,
} from "./managed-lighting-resources";

export type ShadowCost = { bytes: number; passes: number; samplers: number };
const reservations = new WeakMap<AbstractEngine, Map<Scene, ShadowCost>>();
/**
 * View shadow map releases still waiting for WebGPU's end-of-frame destruction,
 * per Engine: their textures hold memory the ledger may already count as free,
 * whichever Scene released them (a closed Scene's maps outlive its controller).
 */
const viewShadowDrains = new WeakMap<AbstractEngine, { count: number }>();

/** Pending deferred view shadow map releases on `engine`, across every Scene. */
export function pendingViewShadowDrains(engine: AbstractEngine): number {
  return viewShadowDrains.get(engine)?.count ?? 0;
}

/**
 * Counts a deferred view shadow map release until it settles (resolved or
 * rejected). The returned promise resolves once it no longer counts.
 */
export function trackViewShadowDrain(engine: AbstractEngine, release: Promise<unknown>): Promise<void> {
  let drains = viewShadowDrains.get(engine);
  if (!drains) viewShadowDrains.set(engine, (drains = { count: 0 }));
  const counted = drains;
  counted.count++;
  return release.then(() => {}, () => {}).then(() => { counted.count--; });
}

// Per-Engine shadow category ceiling. Cluster textures additionally consume the
// shared managed lighting byte allowance; neither is total GPU memory.
export const ENGINE_SHADOW_BUDGET = { bytes: 512 * 1024 ** 2, passes: 64 };

/** Matches Babylon's default RGBA half/float/byte choice, plus conservative depth. */
export function shadowBytesPerTexel(engine: AbstractEngine): number {
  const caps = engine.getCaps();
  const color =
    caps.textureHalfFloatRender && caps.textureHalfFloatLinearFiltering
      ? 8
      : caps.textureFloatRender && caps.textureFloatLinearFiltering
        ? 16
        : 4;
  return color + 4;
}

export function otherShadowReservations(scene: Scene): ShadowCost {
  const total = { bytes: 0, passes: 0, samplers: 0 };
  for (const [client, cost] of reservations.get(scene.getEngine()) ?? []) {
    if (client === scene) continue;
    total.bytes += cost.bytes;
    total.passes += cost.passes;
  }
  return total;
}

export function reserveSceneShadows(scene: Scene, cost: ShadowCost): void {
  const engine = scene.getEngine();
  reserveManagedShadowBytes(engine, scene, cost.bytes);
  let clients = reservations.get(engine);
  if (!clients) {
    clients = new Map();
    reservations.set(engine, clients);
  }
  if (cost.bytes === 0) clients.delete(scene);
  else clients.set(scene, cost);
}

/** This Scene may replace its own shadows, but cannot spend any cluster lease. */
export function availableSceneShadowBytes(scene: Scene): number {
  return (
    availableManagedLightingBytes(scene.getEngine()) +
    (reservations.get(scene.getEngine())?.get(scene)?.bytes ?? 0)
  );
}
