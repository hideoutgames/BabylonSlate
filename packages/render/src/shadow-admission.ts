import type { AbstractEngine, Scene } from "@babylonjs/core";

import { availableManagedLightingBytes, reserveManagedShadowBytes } from "./managed-lighting-resources";

export type ShadowCost = { bytes: number; passes: number; samplers: number };
const reservations = new WeakMap<AbstractEngine, Map<Scene, ShadowCost>>();

// Shared by every Scene/Play/preview client. This shadow-only ceiling deliberately
// leaves other resource categories outside the allocation allowance; it is not a
// browser VRAM measurement or a complete engine resource ledger.
export const ENGINE_SHADOW_BUDGET = { bytes: 512 * 1024 ** 2, passes: 64 };
export const SHADOW_MATERIAL_SAMPLER_RESERVE = 8;

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
  return availableManagedLightingBytes(scene.getEngine()) +
    (reservations.get(scene.getEngine())?.get(scene)?.bytes ?? 0);
}
