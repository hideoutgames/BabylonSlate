import type { BaseTexture, InternalTexture, RenderTargetWrapper, Scene } from "@babylonjs/core";

/**
 * The native textures a Scene still references: every texture registered with it, every texture
 * its Materials sample, and its environment textures. Textures built on the Engine rather than the
 * Scene (the ResourceCache's) reach it only through a Material or the environment, so
 * `scene.textures` alone would miss them. A render target holds more than its colour texture: its
 * depth/stencil texture and every attachment of a multi render target are separate native textures
 * the Engine caches, so they are held with it. Reading never creates a texture.
 */
export function internalTexturesHeldByScene(scene: Scene): Set<InternalTexture> {
  const held = new Set<InternalTexture>();
  const hold = (texture: BaseTexture | null | undefined) => {
    const internal = texture?.getInternalTexture();
    if (internal) held.add(internal);
    const target = (texture as { renderTarget?: RenderTargetWrapper | null } | null | undefined)?.renderTarget;
    if (!target) return;
    if (target.texture) held.add(target.texture);
    for (const attachment of target.textures ?? []) held.add(attachment);
    if (target.depthStencilTexture) held.add(target.depthStencilTexture);
  };
  for (const texture of scene.textures) hold(texture);
  for (const material of scene.materials) for (const texture of material.getActiveTextures()) hold(texture);
  hold(scene.environmentTexture);
  hold(scene.environmentBRDFTexture);
  return held;
}
