import {
  CascadedShadowGenerator,
  Constants,
  Matrix,
  RenderTargetTexture,
  Vector2,
  Vector3,
  Vector4,
  Viewport,
  ShadowGenerator,
  type AbstractEngine,
  type Camera,
  type DirectionalLight,
  type Effect,
  type Light,
  type PointLight,
  type Scene,
  type SpotLight,
} from "@babylonjs/core";
import { SHADOW_CAPACITY_PROFILES, type ShadowProfile } from "@haptic/core";
import { deviceProfile } from "./device-profile";
import { ShadowAtlasAllocator, type ShadowAtlasTile } from "./shadow-atlas-allocator";
import { recordShadowMapPass, type ShadowTileView } from "./shadow-change-journal";

/**
 * The light block's shadows (`HapticLightingBlock`) live in one depth-only texture per Scene, the shadow
 * atlas, whose tiles each hold one light's shadow. Each shadowed light keeps a Babylon shadow generator and its own
 * render target object, whose framebuffer is the atlas's: Babylon's caster drawing (depth wrappers, bones, morph targets,
 * instances, alpha test) is unchanged, drawn into the light's tile.
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

/**
 * A depth-only render target whose depth texture compares, as the light block samples it. The texture is its depth
 * attachment: without `generateDepthBuffer: false` Babylon's WebGL depth texture also allocates an unused depth
 * renderbuffer of the same size (64 MB at a 4096-texel atlas, 256 MB at 8192), again each time the atlas is made.
 */
function depthTarget(name: string, edge: number, scene: Scene): RenderTargetTexture {
  const target = new RenderTargetTexture(name, edge, scene,
    { generateMipMaps: false, doNotChangeAspectRatio: true, noColorAttachment: true, generateDepthBuffer: false });
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
 * A light's tiles as one render target: the atlas's framebuffer and depth texture, drawn one pass per tile (a sun's
 * cascades are layers) into the atlas's single layer. It never owns the atlas: disposing it leaves the framebuffer to
 * the atlas.
 */
class AtlasTileTarget extends RenderTargetTexture {
  private readonly atlas: RenderTargetTexture;
  readonly tiles: readonly ShadowAtlasTile[];

  constructor(name: string, atlas: RenderTargetTexture, tiles: readonly ShadowAtlasTile[]) {
    const size = tiles[0]!.size;
    // As many passes as tiles: the object renderer takes one per layer.
    super(name, tiles.length > 1 ? { width: size, height: size, layers: tiles.length } : size, atlas.getScene()!,
      { generateMipMaps: false, doNotChangeAspectRatio: true, noColorAttachment: true, delayAllocation: true });
    this.atlas = atlas;
    this.tiles = tiles;
    this.share();
  }

  private share(): void {
    this._renderTarget = this.atlas.renderTarget;
    this._texture = this.atlas.renderTarget?._depthStencilTexture ?? null;
  }

  // Layered, so a render draws a pass per tile.
  override get is2DArray(): boolean {
    return this.tiles.length > 1;
  }

  override set is2DArray(_value: boolean) {}

  override _bindFrameBuffer(faceIndex = 0): void {
    super._bindFrameBuffer(faceIndex, 0);
  }

  override getSize() {
    return { width: this.tiles[0]!.size, height: this.tiles[0]!.size };
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

/** Called once a Scene's atlas map has drawn (`watchShadowDraws`). */
const drawWatchers = new WeakMap<Scene, () => void>();

/** Calls `drawn` each time one of the Scene's atlas maps has drawn, after all its tiles: their views have changed. */
export function watchShadowDraws(scene: Scene, drawn: () => void): void {
  drawWatchers.set(scene, drawn);
}

/** An atlas map's tiles and the view each was last drawn with, which its shadow is sampled by. */
export interface AtlasShadow {
  readonly tiles: readonly ShadowAtlasTile[];
  /** Per tile, the view-projection it was last drawn with: until its first draw, the one it would draw with. */
  readonly drawnViews: readonly Matrix[];
}

/** Texels a PCF tap reads around a position at most: Castaño's 7 × 7 kernel, a texel inward, and a bilinear neighbour. */
const PCF_REACH_TEXELS = 5;

/**
 * How far around a position, in NDC units of `tile`'s view, a receiver's filter reads `shadow`'s map: the PCF kernel, or
 * Contact Hardening's blocker search and penumbra (`hapticContactLit`: the light's size as a share of the tile, scaled
 * by the tile's correction toward the first cascade, the penumbra up to that size again plus ten texels).
 */
function filterReach(shadow: ShadowGenerator, size: number, correction: Vector3 | undefined): number {
  let texels = PCF_REACH_TEXELS;
  if (shadow.useContactHardeningShadow) {
    const scale = Math.max(1, Math.abs(correction?.x ?? 1), Math.abs(correction?.y ?? 1));
    texels += (size + 10) * shadow.contactHardeningLightSizeUVRatio * scale;
  }
  return 2 * texels / size;
}

/**
 * Draws `map`'s passes into its tiles of an `edge`-texel atlas: each pass's viewport is its tile, set once the
 * framebuffer is bound (the object renderer sets the camera's before the bind), and each tile clears only its own depth
 * under a scissor. `drawing(pass)` runs as a pass starts, once Babylon's generator has set its view. Installed once the
 * generator has set its own observers. A real pass of a map in the Scene's atlas (one that clears; readiness probes
 * emit the other render events) is recorded in the Scene's shadow change journal (`recordShadowMapPass`) with its
 * tiles' drawn views, and partial when it skipped a caster that was not ready (Babylon resets the refresh counter).
 */
function drawIntoTiles(map: AtlasTileTarget, shadow: ShadowGenerator & AtlasShadow, atlas: RenderTargetTexture, edge: number, drawing: (pass: number) => void): void {
  const scene = map.getScene()!;
  const viewports = map.tiles.map((tile) => new Viewport(tile.x / edge, tile.y / edge, tile.size / edge, tile.size / edge));
  const views: { view: Matrix; reach: number }[] = map.tiles.map(() => ({ view: Matrix.Identity(), reach: 0 }));
  let pass = 0;
  let cleared = false;
  let partial = false;
  map.ignoreCameraViewport = false;
  map.onBeforeRenderObservable.add((layer) => {
    pass = layer;
    scene.getEngine().setViewport(viewports[layer]!);
    drawing(layer);
  });
  const resetRefreshCounter = map.resetRefreshCounter.bind(map);
  map.resetRefreshCounter = () => {
    if (cleared) partial = true;
    resetRefreshCounter();
  };
  // Only the tile's depth: Babylon's clear would wipe every other light's.
  map.onClearObservable.clear();
  map.onClearObservable.add((engine) => {
    cleared = true;
    const tile = map.tiles[pass]!;
    engine.enableScissor(tile.x, tile.y, tile.size, tile.size);
    try {
      engine.clear(null, false, true, false);
    } finally {
      // A scissor left behind clips every later pass.
      engine.disableScissor();
    }
  });
  map.onAfterUnbindObservable.add(() => {
    if (cleared) {
      // Only the Scene's atlas is sampled by its surfaces; a private one (caster warm-up) is not.
      if (atlases.get(scene)?.target === atlas) {
        const corrections = shadow instanceof AtlasCascadedShadowGenerator ? shadow.cascadeCorrections : undefined;
        for (let i = 0; i < views.length; i++) {
          views[i]!.view.copyFrom(shadow.drawnViews[i]!);
          views[i]!.reach = filterReach(shadow, map.tiles[i]!.size, corrections?.[i]);
        }
        recordShadowMapPass(scene, map, views as ShadowTileView[], partial);
      }
      cleared = false;
      partial = false;
    }
    drawWatchers.get(scene)?.();
  });
}

type Placement = { atlas: Atlas; tiles: ShadowAtlasTile[] };
let placing: Placement | null = null;
/** The atlas maps are placed in instead of the Scene's while `placeInPrivateAtlas` builds them. */
let privateAtlas: Atlas | null = null;

/** A depth-only atlas of the Scene atlas's format for maps no light samples (`createPrivateShadowAtlas`). */
export type PrivateShadowAtlas = { readonly target: RenderTargetTexture; readonly tiles: ShadowAtlasAllocator };

/**
 * A depth-only atlas of `edge` texels and the Scene atlas's format, kept out of the Scene's texture list (views count
 * the Scene's textures), for maps that are never sampled: they hold none of the Scene atlas's area or memory. Disposed
 * with the Scene, or by its owner.
 */
export function createPrivateShadowAtlas(scene: Scene, edge: number): PrivateShadowAtlas {
  const entities = scene as unknown as { _blockEntityCollection: boolean };
  const blocked = entities._blockEntityCollection;
  entities._blockEntityCollection = true;
  try {
    const target = depthTarget("hapticShadowAtlasPrivate", edge, scene);
    disposeWithScene(scene, target, () => {});
    return { target, tiles: new ShadowAtlasAllocator(edge) };
  } finally {
    entities._blockEntityCollection = blocked;
  }
}

/** The private atlases whose tile clear `prepareTileClear` has drawn. */
const preparedClears = new WeakSet<RenderTargetTexture>();

/**
 * On WebGPU a tile's scissored clear draws Babylon's clear quad, whose render pipeline for the atlas's format the first
 * such clear creates synchronously, blocking a frame. Draws one into `atlas` (the Scene atlas's format) once the quad's
 * shader has compiled, so the pipeline exists before the Scene atlas's first tile clears; true once it has (at once on
 * WebGL2, which clears without a pipeline).
 */
export function prepareTileClear(atlas: PrivateShadowAtlas): boolean {
  const target = atlas.target;
  const engine = target.getScene()!.getEngine();
  if (!engine.isWebGPU || preparedClears.has(target)) return true;
  const renderTarget = target.renderTarget;
  if (!renderTarget || !tileClearsReady(engine)) return false;
  engine.bindFramebuffer(renderTarget);
  engine.enableScissor(0, 0, 1, 1);
  try {
    engine.clear(null, false, true, false);
  } finally {
    engine.disableScissor();
    engine.unBindFramebuffer(renderTarget);
  }
  preparedClears.add(target);
  return true;
}

/** Runs `build` with the atlas maps it makes placed in `atlas` rather than the Scene's atlas. */
export function placeInPrivateAtlas<T>(atlas: PrivateShadowAtlas, build: () => T): T {
  privateAtlas = atlas;
  try {
    return build();
  } finally {
    privateAtlas = null;
  }
}

/**
 * The tile edge of each of a sun's `cascades` at map size `size`: the last `halved` take half the edge, never the first
 * two, which hold the shadows near the camera (the second starts a few metres out), down to the 256-texel floor
 * admitted maps keep and never more than `size` (a caster-variant stand-in's tiles are smaller still;
 * `SHADOW_HALF_TILE_CASCADES`).
 */
export function cascadeTileSizes(size: number, cascades: number, halved: number): number[] {
  const first = Math.max(2, cascades - halved);
  const far = size > 256 ? Math.max(256, size / 2) : size;
  return Array.from({ length: cascades }, (_, index) => (index < first ? size : far));
}

/** Allocates tiles of `sizes` texels in the Scene's `edge`-texel atlas, or none when one does not fit. */
function place(scene: Scene, sizes: readonly number[], edge: number): Placement | null {
  const atlas = privateAtlas ?? sceneAtlas(scene, edge);
  const tiles: ShadowAtlasTile[] = [];
  for (const size of sizes) {
    const tile = atlas.tiles.allocate(size);
    if (!tile) {
      for (const placed of tiles) atlas.tiles.free(placed);
      return null;
    }
    tiles.push(tile);
  }
  return { atlas, tiles };
}

/** Builds a generator into `placement`'s tiles, giving them back if its construction fails. */
function construct<T>(placement: Placement, build: () => T): T {
  placing = placement;
  try {
    return build();
  } catch (error) {
    for (const tile of placement.tiles) placement.atlas.tiles.free(tile);
    throw error;
  } finally {
    placing = null;
  }
}

/**
 * A spot or point light's shadow generator drawing into its tiles of the Scene's atlas: a spot light's one, a point
 * light's six, one per cube face in Babylon's order (+X, -X, -Y, +Y, +Z, -Z), each a 90-degree view drawn and sampled
 * as a spot light's is. Made only while that many tiles of its size are free (`createAtlasShadowGenerator`). It moves
 * between lights of its kind (`moveTo`), keeping its tiles, render target, pass ids and casters' draw wrappers, so an
 * admission change needs no construction, disposal or shader loading; disposing it frees its tiles.
 */
export class AtlasShadowGenerator extends ShadowGenerator implements AtlasShadow {
  // Set while Babylon's constructor builds the map, before field initializers would run.
  declare private placement: Placement;
  declare private views: Matrix[];
  /**
   * The map size the shadow quality level asks of a local light (`applyShadowSettings`), against which the filter holds
   * its width in the world when admission gave the tiles less (`shadowKernelScale`); 0 is the tiles' own.
   */
  filterReferenceSize = 0;
  private drawn = false;
  private readonly range = new Vector2(0, 1);

  get tiles(): readonly ShadowAtlasTile[] {
    return this.placement.tiles;
  }

  canMoveTo(light: SpotLight | PointLight): boolean {
    const current = this._light;
    return (
      light !== current &&
      light.getScene() === current.getScene() &&
      light.getTypeID() === current.getTypeID() &&
      light.needCube() === current.needCube() &&
      !light.getShadowGenerators()?.size
    );
  }

  /**
   * Babylon 9.29 reads the owning light live everywhere except its transform cache. Receivers are not dirtied; the
   * caller owns their transition.
   */
  moveTo(light: SpotLight | PointLight): void {
    if (!this.canMoveTo(light))
      throw new Error("A shadow map can only move to an unshadowed light of the same kind.");
    const previous: Light = this._light;
    const generators = previous._shadowGenerators;
    if (generators) {
      for (const [camera, generator] of generators)
        if (generator === this) generators.delete(camera);
      // Match ShadowGenerator.dispose: an empty map stands for none.
      if (!generators.size) previous._shadowGenerators = null;
    }
    (light._shadowGenerators ??= new Map()).set(this.camera, this);
    this._light = light;
    this.id = light.id;
    this._currentRenderId = -1;
    this._cachedPosition.setAll(Number.MAX_VALUE);
    this._cachedDirection.setAll(Number.MAX_VALUE);
  }

  /** The first tile, in texels of the atlas. */
  get tile(): ShadowAtlasTile {
    return this.placement.tiles[0]!;
  }

  get drawnViews(): readonly Matrix[] {
    // A spot light's view until its first draw; a point light's faces are drawn in turn.
    if (!this.drawn && this.views.length === 1) {
      this.views[0]!.copyFrom(this.getTransformMatrix());
      this.recordRange();
    }
    return this.views;
  }

  /**
   * The near and far planes of the perspective views it was last drawn with, which Contact Hardening reads depth over:
   * until its first draw, those it would draw with.
   */
  get drawnDepthRange(): Vector2 {
    return this.range;
  }

  /** The planes of Babylon's perspective projection it draws with (`PerspectiveFovLHToRef`, depth not reversed). */
  private recordRange(): void {
    const m = (this as unknown as { _projectionMatrix: Matrix })._projectionMatrix.m;
    const near = this._scene.getEngine().isNDCHalfZRange ? -m[14]! / m[10]! : -m[14]! / (m[10]! + 1);
    const far = -m[14]! / (m[10]! - 1);
    // A view not yet computed (an identity projection) has none.
    if (Number.isFinite(near) && Number.isFinite(far) && far > near) this.range.set(near, far);
  }

  // PCF on a point light's faces too: Babylon's own cube maps fall back to Poisson sampling, whose casters write no
  // biased depth.
  override get filter(): number {
    return super.filter;
  }

  override set filter(value: number) {
    if (!this._light.needCube()) {
      super.filter = value;
      return;
    }
    if (this._filter === value) return;
    this._filter = value;
    this._light._markMeshesAsLightDirty();
  }

  protected override _createTargetRenderTexture(): void {
    this.placement ??= placing!;
    this.views ??= this.placement.tiles.map(() => Matrix.Identity());
    this._shadowMap?.dispose();
    const map = new AtlasTileTarget(`${this._light.name}_shadowTile`, this.placement.atlas.target, this.placement.tiles);
    map.noPrePassRenderer = true;
    this._shadowMap = map;
  }

  protected override _initializeShadowMap(): void {
    super._initializeShadowMap();
    // Babylon's observer has set the pass's face (`_currentFaceIndex`) by now, so the view is that face's.
    drawIntoTiles(this._shadowMap as AtlasTileTarget, this, this.placement.atlas.target, this.placement.atlas.tiles.edge, (face) => {
      this.views[face]!.copyFrom(this.getTransformMatrix());
      this.recordRange();
      this.drawn = true;
    });
  }

  // The atlas keeps its own bilinear compare filtering: a filter's sampling mode would change every tile's.
  protected override _applyFilterValues(): void {}

  override dispose(): void {
    super.dispose();
    for (const tile of this.placement.tiles) this.placement.atlas.tiles.free(tile);
  }
}

/**
 * A spot or point light's shadow generator with `size`-texel tiles of the Scene's `edge`-texel atlas (a point light's
 * six, one per cube face), or null when the atlas has not that many free.
 */
export function createAtlasShadowGenerator(light: SpotLight | PointLight, size: number, edge: number): AtlasShadowGenerator | null {
  const placement = place(light.getScene(), Array.from({ length: light.needCube() ? 6 : 1 }, () => size), edge);
  return placement && construct(placement, () => new AtlasShadowGenerator(size, light));
}

/**
 * The sun's cascaded shadow generator drawing each cascade into its own tile of the Scene's atlas, built with its
 * cascade count (`createAtlasCascadedShadowGenerator`), which a change of count rebuilds. Disposing it frees the tiles.
 */
export class AtlasCascadedShadowGenerator extends CascadedShadowGenerator implements AtlasShadow {
  declare private placement: Placement;
  declare private views: Matrix[];
  private readonly ends: number[] = [];
  private readonly lengths: number[] = [];
  private readonly depth = new Vector4(0, 0, 0, 0);
  declare private corrections: Vector3[];
  /** The share of the shadow distance's far end over which the shadow fades out (`ShadowSettings.fadeFraction`). */
  fadeFraction = 0;
  /** Automatic bias (`ShadowSettings.autoBias`): receivers compare against their own plane (receiver-plane PCF). */
  autoBias = false;
  /**
   * The smallest caster a cascade after the first draws, its bounding sphere's diameter in that cascade's texels
   * (`SHADOW_FAR_CASTER_MIN_TEXELS` of the shadow quality level; `castsIntoCascade`); 0 draws every caster.
   */
  farCasterMinTexels = 0;

  get tiles(): readonly ShadowAtlasTile[] {
    return this.placement.tiles;
  }

  get drawnViews(): readonly Matrix[] {
    return this.views;
  }

  /** Per cascade, its far end in view depth from the camera it was last drawn for (Babylon's `viewFrustumZ`). */
  get cascadeEnds(): readonly number[] {
    return this.ends;
  }

  /** Per cascade as last drawn: its far end in view depth and the map texels per world metre across its tile. */
  get cascadeDensity(): { end: number; texelsPerMetre: number }[] {
    return this.ends.map((end, index) => {
      const width = (this.getCascadeMaxExtents(index)?.x ?? 0) - (this.getCascadeMinExtents(index)?.x ?? 0);
      return { end, texelsPerMetre: width > 0 ? this.mapSize / width : 0 };
    });
  }

  /** Per cascade, its length in view depth as last drawn (Babylon's `frustumLengths`), over which it blends into the next. */
  get cascadeLengths(): readonly number[] {
    return this.lengths;
  }

  /** The view depth plane (world position to depth) of the camera the cascades were last drawn for. */
  get cascadeDepth(): Vector4 {
    return this.depth;
  }

  /**
   * Per cascade, as last drawn, Contact Hardening's corrections toward the first cascade (Babylon's
   * `_lightSizeUVCorrection` and `_depthCorrection`): its width and height over the first's, and its depth range over the
   * first's, so a penumbra keeps its size in the world from cascade to cascade.
   */
  get cascadeCorrections(): readonly Vector3[] {
    return this.corrections;
  }

  protected override _initializeGenerator(): void {
    // Built with its count: Babylon's default of four would take four tiles before the count could be lowered.
    (this as unknown as { _numCascades?: number })._numCascades ??= placing!.tiles.length;
    super._initializeGenerator();
  }

  protected override _createTargetRenderTexture(): void {
    this.placement ??= placing!;
    if (this.numCascades !== this.placement.tiles.length) throw new Error("An atlas cascade map keeps the cascade count it was built with.");
    // Each cascade's fit snaps to its own tile's texels (a Babylon patch hunk).
    (this as unknown as { _cascadeMapSizes: number[] })._cascadeMapSizes = this.placement.tiles.map((tile) => tile.size);
    this.views ??= this.placement.tiles.map(() => Matrix.Identity());
    this.corrections ??= this.placement.tiles.map(() => new Vector3(1, 1, 1));
    this._shadowMap?.dispose();
    const map = new AtlasTileTarget(`${this._light.name}_shadowTiles`, this.placement.atlas.target, this.placement.tiles);
    map.noPrePassRenderer = true;
    this._shadowMap = map;
  }

  protected override _initializeShadowMap(): void {
    super._initializeShadowMap();
    const csm = this as unknown as {
      _viewSpaceFrustumsZ: number[]; _frustumLengths: number[]; _cascadeMinExtents: Vector3[]; _cascadeMaxExtents: Vector3[];
    };
    drawIntoTiles(this._shadowMap as AtlasTileTarget, this, this.placement.atlas.target, this.placement.atlas.tiles.edge, (cascade) => {
      this.views[cascade]!.copyFrom(this.getCascadeTransformMatrix(cascade)!);
      // The splits the cascades are drawn for, computed as the map binds.
      if (cascade === 0) {
        this.ends.splice(0, Infinity, ...csm._viewSpaceFrustumsZ);
        this.lengths.splice(0, Infinity, ...csm._frustumLengths);
        const camera = this._getCamera();
        if (camera) {
          const m = camera.getViewMatrix().m, eye = camera.globalPosition;
          this.depth.set(m[2]!, m[6]!, m[10]!, -(m[2]! * eye.x + m[6]! * eye.y + m[10]! * eye.z));
        }
        const min = csm._cascadeMinExtents, max = csm._cascadeMaxExtents;
        // A flat cascade (no extent) keeps the first's sizes.
        const ratio = (a: number, b: number) => (a / b > 0 && Number.isFinite(a / b) ? a / b : 1);
        this.corrections.forEach((correction, index) => correction.set(
          ratio(max[0]!.x - min[0]!.x, max[index]!.x - min[index]!.x),
          ratio(max[0]!.y - min[0]!.y, max[index]!.y - min[index]!.y),
          ratio(max[index]!.z - min[index]!.z, max[0]!.z - min[0]!.z)));
      }
    });
  }

  protected override _applyFilterValues(): void {}

  override dispose(): void {
    super.dispose();
    for (const tile of this.placement.tiles) this.placement.atlas.tiles.free(tile);
  }
}

/** The edge in texels of the tile `generator`'s pass `layer` draws (a cascade, a cube face), or its map's for any other. */
export function shadowTileSize(generator: ShadowGenerator, layer: number): number {
  if (isAtlasShadow(generator)) return (generator.tiles[layer] ?? generator.tiles[0]!).size;
  return generator.getShadowMap()?.getSize().width ?? 0;
}

/** Whether `generator` draws into the atlas. */
export function isAtlasShadow(generator: unknown): generator is AtlasShadowGenerator | AtlasCascadedShadowGenerator {
  return generator instanceof AtlasShadowGenerator || generator instanceof AtlasCascadedShadowGenerator;
}

/**
 * The sun's cascaded shadow generator with `cascades` tiles of `size` texels in the Scene's `edge`-texel atlas, or null
 * when the atlas has not that many free.
 */
export function createAtlasCascadedShadowGenerator(
  light: DirectionalLight, size: number, cascades: number, edge: number, camera?: Camera, halved = 0,
): AtlasCascadedShadowGenerator | null {
  const placement = place(light.getScene(), cascadeTileSizes(size, cascades, halved), edge);
  return placement && construct(placement, () => askingLightEngine(light, () => new AtlasCascadedShadowGenerator(size, light, undefined, camera)));
}

/**
 * Runs `build` with Babylon 9.29's `CascadedShadowGenerator.IsSupported`, which its constructor checks, asking
 * `light`'s Engine. Babylon asks the last-created Engine, which a model conversion's NullEngine (OBJ, FBX, STL) is
 * while it runs, and the rejected constructor throws, failing the sun's shadow until a settings change.
 */
function askingLightEngine<T>(light: DirectionalLight, build: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(CascadedShadowGenerator, "IsSupported")!;
  const supported = light.getScene().getEngine()._features.supportCSM;
  Object.defineProperty(CascadedShadowGenerator, "IsSupported", { configurable: true, get: () => supported });
  try {
    return build();
  } finally {
    Object.defineProperty(CascadedShadowGenerator, "IsSupported", descriptor);
  }
}
