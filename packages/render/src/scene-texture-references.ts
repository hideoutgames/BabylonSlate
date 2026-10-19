import type { BaseTexture, InternalTexture, Scene } from "@babylonjs/core";

/**
 * The native textures a Scene still references: every texture registered with it, every texture
 * its Materials sample, and its environment textures. Textures built on the Engine rather than the
 * Scene (the ResourceCache's) reach it only through a Material or the environment, so
 * `scene.textures` alone would miss them. Reading never creates a texture.
 */
export function internalTexturesHeldByScene(scene: Scene): Set<InternalTexture> {
  const held = new Set<InternalTexture>();
  const hold = (texture: BaseTexture | null | undefined) => {
    const internal = texture?.getInternalTexture();
    if (internal) held.add(internal);
  };
  for (const texture of scene.textures) hold(texture);
  for (const material of scene.materials) for (const texture of material.getActiveTextures()) hold(texture);
  hold(scene.environmentTexture);
  hold(scene.environmentBRDFTexture);
  return held;
}
