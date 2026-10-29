import { Constants, RenderTargetTexture, Viewport, type AbstractEngine, type Effect, type Scene, type SpotLight } from "@babylonjs/core";
import { SHADOW_CAPACITY_PROFILES, type ShadowProfile } from "@haptic/core";
import { deviceProfile } from "./device-profile";
import { ReusableShadowGenerator } from "./reusable-shadow-generator";
import { ShadowAtlasAllocator, type ShadowAtlasTile } from "./shadow-atlas-allocator";

/**
 * Lighting plan: the light block's shadows (`HapticLightingBlock`) live in one depth-only texture per Scene, the shadow
 * atlas, whose tiles each hold one light's shadow. Each shadowed light keeps a Babylon shadow generator and its own
 * render target object, whose framebuffer is the atlas's: Babylon's caster drawing (depth wrappers, bones, morph targets,
 * instances, alpha test) is unchanged, drawn into the light's tile. Behind the lighting plan's Engine switch.
 */

/** Bytes per texel of the atlas: 32-bit depth, its only attachment. */
export const SHADOW_ATLAS_BYTES_PER_TEXEL = 4;

/**
 * The atlas's edge in texels at a shadow quality level: the largest power of two whose depth fits the level's shadow
 * byte budget (Low and Medium 4096, High and Ultra 8192), within the device's texture limit and its device class's cap
 * (`DeviceProfile.shadowAtlasCap`).
 */
export function shadowAtlasEdge(engine: AbstractEngine, profile: ShadowProfile): number {
  const fits = Math.sqrt(SHADOW_CAPACITY_PROFILES[profile].byteBudget / SHADOW_ATLAS_BYTES_PER_TEXEL);
  const edge = Math.min(fits, engine.getCaps().maxTextureSize, deviceProfile().shadowAtlasCap ?? Infinity);
  return 2 ** Math.floor(Math.log2(edge));
}

type Atlas = { target: RenderTargetTexture; tiles: ShadowAtlasAllocator };
const atlases = new WeakMap<Scene, Atlas>();
const placeholders = new WeakMap<Scene, RenderTargetTexture>();

/** Disposes `target` with the Scene; `forget` runs once it is disposed, by the Scene or otherwise. */
function disposeWithScene(scene: Scene, target: RenderTargetTexture, forget: () => void): void {
  const sceneDisposed = scene.onDisposeObservable.addOnce(() => target.dispose());
  target.onDisposeObservable.addOnce(() => {
    scene.onDisposeObservable.remove(sceneDisposed);
    forget();
  });
}

/** A depth-only render target whose depth texture compares, as the light block samples it. */
function depthTarget(name: string, edge: number, scene: Scene): RenderTargetTexture {
  const target = new RenderTargetTexture(name, edge, scene, { generateMipMaps: false, doNotChangeAspectRatio: true, noColorAttachment: true });
  const reverse = scene.getEngine().useReverseDepthBuffer;
  target.createDepthStencilTexture(reverse ? Constants.GREATER : Constants.LESS, true, false, 1, Constants.TEXTUREFORMAT_DEPTH32_FLOAT, name);
  return target;
}

/**
 * The Scene's atlas at `edge` texels, made with its first tile and disposed with the Scene, or replaced once no tile
 * is left in it (a quality level of another edge rebuilds every atlas map, whose allocation keys carry the edge). A
 * shadow allocation that fails disposes the textures it made, the atlas among them when that tile was its first: the
 * next tile makes it again.
 */
function sceneAtlas(scene: Scene, edge: number): Atlas {
  let atlas = atlases.get(scene);
  if (atlas && atlas.tiles.edge !== edge) {
    if (!atlas.tiles.empty) throw new Error(`The shadow atlas is ${atlas.tiles.edge} texels, not ${edge}, while it holds tiles.`);
    atlas.target.dispose();
    atlas = undefined;
  }
  if (!atlas) {
    const target = depthTarget("hapticShadowAtlas", edge, scene);
    atlas = { target, tiles: new ShadowAtlasAllocator(edge) };
    atlases.set(scene, atlas);
    disposeWithScene(scene, target, () => atlases.delete(scene));
  }
  return atlas;
}

/** Disposes the Scene's atlas once it holds no tile, as its last map is released: its memory follows its use. */
export function releaseEmptyShadowAtlas(scene: Scene): void {
  const atlas = atlases.get(scene);
  if (atlas?.tiles.empty) atlas.target.dispose();
}

/** The bytes the Scene's atlas holds: none until its first tile. */
export function shadowAtlasBytes(scene: Scene): number {
  const edge = atlases.get(scene)?.tiles.edge ?? 0;
  return edge ** 2 * SHADOW_ATLAS_BYTES_PER_TEXEL;
}

/**
 * What the light block samples its shadows from: the atlas once a light has a tile, else a one-texel depth target of
 * the same kind, as WebGPU draws only with every declared texture bound. No light samples the stand-in.
 */
export function shadowAtlasTexture(scene: Scene): RenderTargetTexture {
  const atlas = atlases.get(scene)?.target;
  if (atlas) return atlas;
  let placeholder = placeholders.get(scene);
  if (!placeholder) {
    placeholder = depthTarget("hapticShadowAtlasPlaceholder", 1, scene);
    placeholders.set(scene, placeholder);
    disposeWithScene(scene, placeholder, () => placeholders.delete(scene));
  }
  return placeholder;
}

/**
 * On WebGPU a scissored clear draws Babylon's clear quad, whose pipeline lookup throws until its shader has compiled;
 * a tile waits for it rather than draw over depth it could not clear.
 */
function tileClearsReady(engine: AbstractEngine): boolean {
  const quad = (engine as { _clearQuad?: { _effect?: Effect } })._clearQuad;
  return !quad?._effect || quad._effect.isReady();
}

/**
 * A light's tile as a render target: the atlas's framebuffer and depth texture, sized and cleared as the tile. Its
 * viewport is set once the framebuffer is bound (`onBeforeRenderObservable`): the object renderer sets the camera's
 * before the bind. It never owns the atlas: disposing it leaves the framebuffer to the atlas.
 */
class AtlasTileTarget extends RenderTargetTexture {
  private readonly atlas: RenderTargetTexture;
  readonly tile: ShadowAtlasTile;

  constructor(name: string, atlas: RenderTargetTexture, tile: ShadowAtlasTile) {
    super(name, tile.size, atlas.getScene()!, { generateMipMaps: false, doNotChangeAspectRatio: true, noColorAttachment: true, delayAllocation: true });
    this.atlas = atlas;
    this.tile = tile;
    this.share();
    const edge = atlas.getRenderSize();
    const viewport = new Viewport(tile.x / edge, tile.y / edge, tile.size / edge, tile.size / edge);
    this.onBeforeRenderObservable.add(() => this.getScene()!.getEngine().setViewport(viewport));
  }

  private share(): void {
    this._renderTarget = this.atlas.renderTarget;
    this._texture = this.atlas.renderTarget?._depthStencilTexture ?? null;
  }

  override getSize() {
    return { width: this.tile.size, height: this.tile.size };
  }

  override render(useCameraPostProcess?: boolean, dumpForDebug?: boolean): void {
    if (!tileClearsReady(this.getScene()!.getEngine())) {
      this.resetRefreshCounter();
      return;
    }
    super.render(useCameraPostProcess, dumpForDebug);
  }

  override releaseInternalTexture(): void {
    this._renderTarget = null;
    this._texture = null;
  }

  override dispose(): void {
    this.releaseInternalTexture();
    super.dispose();
  }

  override _rebuild(): void {
    this.share();
  }
}

let placing: { atlas: Atlas; tile: ShadowAtlasTile } | null = null;

/**
 * A spot light's shadow generator drawing into its tile of the Scene's atlas, made only while a tile of its size is
 * free (`createAtlasShadowGenerator`). It moves between lights as its legacy counterpart does (`moveTo`), keeping its
 * tile; disposing it frees the tile.
 */
export class AtlasShadowGenerator extends ReusableShadowGenerator {
  // Set while Babylon's constructor builds the map, before field initializers would run.
  declare private placement: { atlas: Atlas; tile: ShadowAtlasTile };

  /** The tile, in texels of the atlas. */
  get tile(): ShadowAtlasTile {
    return this.placement.tile;
  }

  protected override _createTargetRenderTexture(): void {
    this.placement ??= placing!;
    this._shadowMap?.dispose();
    const map = new AtlasTileTarget(`${this._light.name}_shadowTile`, this.placement.atlas.target, this.placement.tile);
    map.noPrePassRenderer = true;
    this._shadowMap = map;
  }

  protected override _initializeShadowMap(): void {
    super._initializeShadowMap();
    const map = this._shadowMap!;
    map.ignoreCameraViewport = false;
    // Only the tile's depth: Babylon's clear would wipe every other light's.
    map.onClearObservable.clear();
    const tile = this.placement.tile;
    map.onClearObservable.add((engine) => {
      engine.enableScissor(tile.x, tile.y, tile.size, tile.size);
      try {
        engine.clear(null, false, true, false);
      } finally {
        // A scissor left behind clips every later pass.
        engine.disableScissor();
      }
    });
  }

  // The atlas keeps its own bilinear compare filtering: a filter's sampling mode would change every tile's.
  protected override _applyFilterValues(): void {}

  override dispose(): void {
    super.dispose();
    this.placement.atlas.tiles.free(this.placement.tile);
  }
}

/**
 * A spot light's shadow generator with a `size`-texel tile of the Scene's `edge`-texel atlas, or null when the atlas
 * has no tile of that size free.
 */
export function createAtlasShadowGenerator(light: SpotLight, size: number, edge: number): AtlasShadowGenerator | null {
  const atlas = sceneAtlas(light.getScene(), edge);
  const tile = atlas.tiles.allocate(size);
  if (!tile) return null;
  placing = { atlas, tile };
  try {
    return new AtlasShadowGenerator(size, light);
  } catch (error) {
    atlas.tiles.free(tile);
    throw error;
  } finally {
    placing = null;
  }
}
