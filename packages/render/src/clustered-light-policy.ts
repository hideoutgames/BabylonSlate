import type { Scene } from "@babylonjs/core";

type ClusteredPolicy = { sync(): void; limits(): string[] };
const policies = new WeakMap<Scene, ClusteredPolicy>();

/** One explicit experimental owner per scene; production path selection is unchanged. */
export function registerClusteredLightPolicy(
  scene: Scene,
  policy: ClusteredPolicy,
): () => void {
  if (policies.has(scene))
    throw new Error("Scene already has a clustered light owner.");
  policies.set(scene, policy);
  return () => {
    if (policies.get(scene) === policy) policies.delete(scene);
  };
}

export function syncClusteredLightPolicy(scene: Scene): void {
  policies.get(scene)?.sync();
}

export function clusteredLightingLimits(scene: Scene): string[] {
  return policies.get(scene)?.limits() ?? [];
}
