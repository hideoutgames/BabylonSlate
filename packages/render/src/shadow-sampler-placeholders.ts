import {
  BaseTexture,
  Constants,
  type AbstractEngine,
  type InternalTexture,
  type RenderTargetWrapper,
  type Scene,
} from "@babylonjs/core";

/**
 * One texel of each shadow and light-texture sampler type, bound to a sampler no real texture of its type is bound
 * to: the volumetric march's slots a light's kind does not read, and a receiver drawing its previous Effect whose
 * shader light no longer has the map or texture it was compiled for (`bindLights` in fixed-light-binding.ts). A WebGPU
 * bind group needs a texture of the declared type in every binding, and WebGL2 must not leave a released map (or a
 * texture of another type or comparison mode) behind on a unit. The depth ones carry a comparison function because
 * their samplers compare; which one does not matter.
 */
export interface ShadowSamplerPlaceholders {
  /** 2D depth with comparison (`sampler2DShadow`). */
  readonly compare: BaseTexture;
  /** Cube colour, as a cube shadow map's texture type (`samplerCube`). */
  readonly cube: BaseTexture;
  /** 2D array depth with comparison (`sampler2DArrayShadow`, cascades). */
  readonly cascades: BaseTexture;
  /** 2D colour (`sampler2D`: a PCSS depth texture, a projection, IES or emission texture, area lookup tables). */
  readonly plain: BaseTexture;
  /** 2D array colour (`sampler2DArray`: a cascaded PCSS depth texture). */
  readonly plainCascades: BaseTexture;
}

const placeholders = new WeakMap<Scene, ShadowSamplerPlaceholders>();

/** The scene's placeholders if they exist; never allocates (a draw may ask). */
export function existingShadowSamplerPlaceholders(scene: Scene): ShadowSamplerPlaceholders | undefined {
  return placeholders.get(scene);
}

/**
 * The scene's placeholders, created on first use and disposed with the scene. Create them outside a render pass
 * (while preparing a graph, before a frame's passes): allocating a render target inside a pass would rebind the
 * framebuffer it draws to. Like held images, they are a fixed cost outside the managed render ledger.
 */
export function shadowSamplerPlaceholders(scene: Scene): ShadowSamplerPlaceholders {
  let owned = placeholders.get(scene);
  if (owned) return owned;
  // A disposed scene never notifies its disposal again, so placeholders made for it would never be released.
  if (scene.isDisposed) throw new Error("Shadow sampler placeholders need a live scene.");
  const engine = scene.getEngine();
  const targets: RenderTargetWrapper[] = [];
  const wrap = (target: RenderTargetWrapper, texture: InternalTexture, name: string) => {
    targets.push(target);
    // The wrapper holds its own reference, so the texture and its render target release independently.
    texture.incrementReferences();
    const placeholder = new BaseTexture(engine, texture);
    placeholder.name = name;
    return placeholder;
  };
  const colour = (layers: number, name: string) => engine.createRenderTargetTexture(layers ? { width: 1, height: 1, layers } : { width: 1, height: 1 }, {
    type: Constants.TEXTURETYPE_UNSIGNED_BYTE, format: Constants.TEXTUREFORMAT_RGBA, samplingMode: Constants.TEXTURE_NEAREST_SAMPLINGMODE,
    generateMipMaps: false, generateDepthBuffer: false, generateStencilBuffer: false, label: name,
  });
  let texel: InternalTexture | undefined;
  const depth = (layers: number, name: string) => {
    const target = colour(layers, name);
    texel ??= target.texture ?? undefined;
    // Engines without depth textures (NullEngine) never sample a map by comparison.
    const texture = engine._features.supportDepthStencilTexture
      ? target.createDepthStencilTexture(Constants.LESS, true, false, 1, Constants.TEXTUREFORMAT_DEPTH32_FLOAT, name)
      : target.texture;
    if (!texture) throw new Error("Shadow sampler placeholder could not be allocated.");
    return wrap(target, texture, name);
  };
  const plain = (layers: number, name: string) => {
    const target = colour(layers, name);
    if (!target.texture) throw new Error("Shadow sampler placeholder could not be allocated.");
    return wrap(target, target.texture, name);
  };
  const cube = (name: string) => {
    const target = engine.createRenderTargetCubeTexture(1, {
      type: cubeShadowType(engine), format: Constants.TEXTUREFORMAT_RGBA, samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
      generateMipMaps: false, generateDepthBuffer: false, generateStencilBuffer: false, label: name,
    });
    // NullEngine leaves its cube target's texture unattached; it draws nothing, so the 2D texel serves there.
    const texture = target.texture ?? texel;
    if (!texture) throw new Error("Shadow sampler placeholder could not be allocated.");
    return wrap(target, texture, name);
  };
  owned = {
    compare: depth(0, "shadow-sampler-placeholder"),
    cascades: depth(1, "cascade-shadow-sampler-placeholder"),
    cube: cube("cube-shadow-sampler-placeholder"),
    plain: plain(0, "plain-sampler-placeholder"),
    plainCascades: plain(1, "plain-array-sampler-placeholder"),
  };
  placeholders.set(scene, owned);
  const disposed = owned;
  scene.onDisposeObservable.addOnce(() => {
    for (const texture of Object.values(disposed)) texture.dispose();
    for (const target of targets) target.dispose();
    placeholders.delete(scene);
  });
  return owned;
}

/** The texture type Babylon's shadow generator gives a cube map here, so a placeholder samples like a real map. */
function cubeShadowType(engine: AbstractEngine): number {
  const caps = engine.getCaps();
  if (caps.textureHalfFloatRender && caps.textureHalfFloatLinearFiltering) return Constants.TEXTURETYPE_HALF_FLOAT;
  if (caps.textureFloatRender && caps.textureFloatLinearFiltering) return Constants.TEXTURETYPE_FLOAT;
  return Constants.TEXTURETYPE_UNSIGNED_BYTE;
}
