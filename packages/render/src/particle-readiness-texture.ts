import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Scene } from "@babylonjs/core/scene";

/**
 * The 1x1 textures particle systems hold only to satisfy Babylon's own readiness (`createParticleReadinessTexture`):
 * no shader samples one and no Material refers to one, so one joining or leaving its Scene's textures changes nothing
 * a view has to compile. The Scene renderer leaves them out of what stales its cached readiness.
 */
const placeholders = new WeakSet<BaseTexture>();
const live = new WeakMap<Scene, number>();
/** Above zero while a placeholder is being constructed: Babylon announces a texture from inside its constructor. */
let creating = 0;

/** Creates such a placeholder of `scene` with `create`, known as one from its construction until it is disposed. */
export function createParticleReadinessPlaceholder<T extends BaseTexture>(scene: Scene, create: () => T): T {
  creating += 1;
  let texture: T;
  try {
    texture = create();
  } finally {
    creating -= 1;
  }
  placeholders.add(texture);
  live.set(scene, (live.get(scene) ?? 0) + 1);
  texture.onDisposeObservable.addOnce(() => {
    const count = (live.get(scene) ?? 0) - 1;
    if (count > 0) live.set(scene, count);
    else live.delete(scene);
  });
  return texture;
}

export function isParticleReadinessTexture(texture: BaseTexture): boolean {
  return creating > 0 || placeholders.has(texture);
}

/** How many of `scene`'s textures are placeholders not yet disposed. */
export function particleReadinessTextureCount(scene: Scene): number {
  return live.get(scene) ?? 0;
}
