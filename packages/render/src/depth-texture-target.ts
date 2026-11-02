import { Constants, RenderTargetTexture, type Scene } from "@babylonjs/core";

/**
 * A colour render target whose depth is a 24-bit depth texture, which the forward graph imports as its output depth
 * (material previews and thumbnails, views presented through a render target, SceneLayers). The texture is the
 * framebuffer's only depth: with Babylon's default `generateDepthBuffer`, its WebGL depth texture creation also
 * allocates a depth renderbuffer of the target's size that nothing draws into. Without depth textures (no shipped
 * backend) the target keeps the renderbuffer as its depth instead.
 */
export function createDepthTextureTarget(name: string, size: { width: number; height: number }, scene: Scene): RenderTargetTexture {
  const depthTexture = scene.getEngine().getCaps().depthTextureExtension;
  const target = new RenderTargetTexture(name, size, scene, { generateMipMaps: false, generateDepthBuffer: !depthTexture });
  if (depthTexture) target.createDepthStencilTexture(0, false, false, 1, Constants.TEXTUREFORMAT_DEPTH24);
  return target;
}
