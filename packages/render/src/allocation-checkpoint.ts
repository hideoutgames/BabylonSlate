import type { BaseTexture, Scene } from "@babylonjs/core";

export type AllocationRollback = (options?: {
  /** Owner-specific release that runs first; its failures are collected too. */
  before?: (attempt: (release: () => void) => void) => void;
  /** Which new Scene textures the owner releases; all when omitted. */
  textureFilter?: (texture: BaseTexture) => boolean;
}) => unknown[];

/**
 * Snapshot before a synchronous constructor or growth. The rollback releases only
 * textures, render-target wrappers and internal textures created since, and
 * returns every release failure so each owner keeps its own error shape.
 */
export function beginEngineAllocationCheckpoint(
  scene: Scene,
): AllocationRollback {
  const engine = scene.getEngine();
  const textures = new Set(scene.textures);
  const internals = new Set(engine.getLoadedTexturesCache());
  // Babylon 9.20 has no public wrapper enumeration. Read the typed cache only;
  // all ownership release goes through public dispose methods, never cache edits.
  const wrappers = new Set(engine._renderTargetWrapperCache);
  return ({ before, textureFilter } = {}) => {
    const failures: unknown[] = [];
    const attempt = (release: () => void) => {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    };
    before?.(attempt);
    for (const texture of scene.textures.slice())
      if (!textures.has(texture) && (!textureFilter || textureFilter(texture)))
        attempt(() => texture.dispose());
    // A throwing Engine allocator can create a wrapper before returning it to
    // the RTT. Re-read each cache after public disposal to avoid double release.
    for (const wrapper of engine._renderTargetWrapperCache.slice())
      if (!wrappers.has(wrapper)) attempt(() => wrapper.dispose());
    for (const texture of engine.getLoadedTexturesCache().slice())
      if (
        !internals.has(texture) &&
        !engine._renderTargetWrapperCache.some(
          (wrapper) =>
            wrapper.textures?.includes(texture) ||
            wrapper.depthStencilTexture === texture,
        )
      )
        attempt(() => texture.dispose());
    return failures;
  };
}
