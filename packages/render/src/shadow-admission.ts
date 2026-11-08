import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Scene } from "@babylonjs/core/scene";
import {
  availableManagedRenderBytes,
  reserveManagedShadowBytes,
} from "./managed-render-resources";

export type ShadowCost = {
  bytes: number;
  passes: number;
  /**
   * Of `bytes`, the shadow atlas's growth past its quality level's edge for an explicit Directional Map Size
   * (`sunShadowAtlasEdge`): it brings its own room, so neither ENGINE_SHADOW_BUDGET nor the managed ceiling counts it
   * against other allocations. None when omitted.
   */
  exempt?: number;
};
const reservations = new WeakMap<AbstractEngine, Map<Scene, ShadowCost>>();
// Per-Engine shadow category ceiling. Cluster textures additionally consume the
// shared managed lighting byte allowance; neither is total GPU memory.
export const ENGINE_SHADOW_BUDGET = { bytes: 768 * 1024 ** 2, passes: 64 };

/** Other Scenes' shadow bytes, less their exempt ones, and passes. */
export function otherShadowReservations(scene: Scene): ShadowCost {
  const total = { bytes: 0, passes: 0 };
  for (const [client, cost] of reservations.get(scene.getEngine()) ?? []) {
    if (client === scene) continue;
    total.bytes += cost.bytes - (cost.exempt ?? 0);
    total.passes += cost.passes;
  }
  return total;
}

export function reserveSceneShadows(scene: Scene, cost: ShadowCost): void {
  const engine = scene.getEngine();
  reserveManagedShadowBytes(engine, scene, cost.bytes, cost.exempt ?? 0);
  let clients = reservations.get(engine);
  if (!clients) {
    clients = new Map();
    reservations.set(engine, clients);
  }
  if (cost.bytes === 0) clients.delete(scene);
  else clients.set(scene, cost);
}

/** This Scene may replace its own shadows, but cannot spend any cluster lease. Exempt bytes are not in it. */
export function availableSceneShadowBytes(scene: Scene): number {
  const own = reservations.get(scene.getEngine())?.get(scene);
  return availableManagedRenderBytes(scene.getEngine()) + (own ? own.bytes - (own.exempt ?? 0) : 0);
}
