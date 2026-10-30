import type { AbstractEngine, Scene } from "@babylonjs/core";
import {
  availableManagedLightingBytes,
  reserveManagedShadowBytes,
} from "./managed-lighting-resources";

export type ShadowCost = { bytes: number; passes: number };
const reservations = new WeakMap<AbstractEngine, Map<Scene, ShadowCost>>();
// Per-Engine shadow category ceiling. Cluster textures additionally consume the
// shared managed lighting byte allowance; neither is total GPU memory.
export const ENGINE_SHADOW_BUDGET = { bytes: 768 * 1024 ** 2, passes: 64 };

export function otherShadowReservations(scene: Scene): ShadowCost {
  const total = { bytes: 0, passes: 0 };
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
