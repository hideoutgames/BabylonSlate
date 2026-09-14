import type {
  Camera,
  Light,
  RenderTargetTexture,
  Scene,
} from "@babylonjs/core";

type ClusteredPolicy = {
  sync(): void;
  limits(): string[];
  target(camera: Camera): RenderTargetTexture | undefined;
  ownsContainer(light: Light): boolean;
  allowsLocal(light: Light): boolean;
  clusteredCount(): number;
};
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

/** Borrowed target; ownership remains with the explicit scene policy. */
export function clusteredLightTarget(
  scene: Scene,
  camera: Camera,
): RenderTargetTexture | undefined {
  return policies.get(scene)?.target(camera);
}

export function isManagedClusteredLight(scene: Scene, light: Light): boolean {
  return policies.get(scene)?.ownsContainer(light) ?? false;
}

/** The cluster container is not another authored local contribution. */
export function clusteredLocalContributionCount(scene: Scene): number {
  return policies.get(scene)?.clusteredCount() ?? 0;
}

/** Shared quality selection also limits requested conventional fallback lights. */
export function isClusteredLocalAllowed(scene: Scene, light: Light): boolean {
  return policies.get(scene)?.allowsLocal(light) ?? true;
}
