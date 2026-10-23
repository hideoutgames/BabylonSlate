import { InternalTexture, InternalTextureSource, type AbstractEngine } from "@babylonjs/core";

/**
 * Babylon 9.29 NullEngine has no depth-array texture and ignores
 * `size.layers` for a render target's color attachment. Supply only those GPU
 * boundaries so the real CascadedShadowGenerator, its map and the native
 * per-layer render loop (which reads the array metadata) run headlessly.
 */
export function enableHeadlessCascades(engine: AbstractEngine): void {
  engine._features.supportCSM = true;
  engine._features.supportShadowSamplers = true;
  const createTarget = engine.createRenderTargetTexture.bind(engine);
  engine.createRenderTargetTexture = (size, options) => {
    const target = createTarget(size, options);
    if (typeof size !== "number" && size.layers && target.texture) {
      target.texture.depth = target.texture.baseDepth = size.layers;
      target.texture.is2DArray = true;
    }
    return target;
  };
  engine.createDepthStencilTexture = (size, options) => {
    const texture = new InternalTexture(engine, InternalTextureSource.DepthStencil);
    const dimensions = typeof size === "number" ? { width: size, height: size } : size;
    texture.width = texture.baseWidth = dimensions.width;
    texture.height = texture.baseHeight = dimensions.height;
    texture.depth = texture.baseDepth = dimensions.layers ?? 0;
    texture.is2DArray = texture.depth > 0;
    texture.format = options.depthTextureFormat ?? 14;
    texture.isReady = true;
    engine.getLoadedTexturesCache().push(texture);
    return texture;
  };
}

/**
 * Babylon 9.29 NullEngine creates a cube render target's texture without attaching it to the target, so a point
 * light's map never reports a texture. Attach it, so a point light can cast shadows headlessly.
 */
export function enableHeadlessCubeTargets(engine: AbstractEngine): void {
  const createCube = engine.createRenderTargetCubeTexture.bind(engine);
  engine.createRenderTargetCubeTexture = (size, options) => {
    const target = createCube(size, options);
    const created = engine.getLoadedTexturesCache().at(-1);
    if (!target.texture && created?.isCube) target.setTexture(created, 0, false);
    return target;
  };
}
