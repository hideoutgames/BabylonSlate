import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import type { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import type { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import type { Light } from "@babylonjs/core/Lights/light";
import type { PointLight } from "@babylonjs/core/Lights/pointLight";
import type { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Matrix, Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Viewport } from "@babylonjs/core/Maths/math.viewport";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { Scene } from "@babylonjs/core/scene";
import { SHADOW_CAPACITY_PROFILES, type ShadowProfile } from "@haptic/core";
import { deviceProfile } from "./device-profile";
import { ShadowAtlasAllocator, type ShadowAtlasTile } from "./shadow-atlas-allocator";
import { recordShadowMapPass, type ShadowTileView } from "./shadow-change-journal";
import { shadowDebugOff } from "./shadow-debug";
import { applyVertexDepthClamp } from "./shadow-vertex-clamp";

/**
 * The light block's shadows (`HapticLightingBlock`) live in one depth-only texture per Scene, the shadow
 * atlas, whose tiles each hold one light's shadow. The atlas is a depth texture array: its edge is split into square
 * pages (`shadowAtlasPageEdge`), one layer each, and a tile lies in one page. A pass binds only its tile's page, so on a
 * tile-based GPU it loads and stores that page, never the whole atlas, and a page holding only the tiles a render draws
 * is cleared whole (a clear load action) instead of tile by tile. Each shadowed light keeps a Babylon shadow generator
 * and its own render target object, whose framebuffer is the atlas's: Babylon's caster drawing (depth wrappers, bones,
 * morph targets, instances, alpha test) is unchanged, drawn into the light's tile.
 */

/** Bytes per texel of the atlas: 32-bit depth, its only attachment. */
export const SHADOW_ATLAS_BYTES_PER_TEXEL = 4;

/** The largest atlas edge: an 8192 Directional Map Size's cascades need 16384 (1 GiB of depth, `sunShadowAtlasEdge`). */
export const SHADOW_ATLAS_MAX_EDGE = 16384;

/** The largest atlas edge this device makes: SHADOW_ATLAS_MAX_EDGE within its texture limit and its device class's cap. */
export function shadowAtlasEdgeLimit(engine: AbstractEngine): number {
  const edge = Math.min(SHADOW_ATLAS_MAX_EDGE, engine.getCaps().maxTextureSize, deviceProfile().shadowAtlasCap ?? Infinity);
  return 2 ** Math.floor(Math.log2(edge));
}

/**
 * The atlas's edge in texels at a shadow quality level: the largest power of two whose depth fits the level's shadow
 * byte budget (Low and Medium 4096, High and Ultra 8192), within `shadowAtlasEdgeLimit`. A sun asking for more grows
 * it (`sunShadowAtlasEdge`).
 */
export function shadowAtlasEdge(engine: AbstractEngine, profile: ShadowProfile): number {
  const fits = Math.sqrt(SHADOW_CAPACITY_PROFILES[profile].byteBudget / SHADOW_ATLAS_BYTES_PER_TEXEL);
  return Math.min(2 ** Math.floor(Math.log2(fits)), shadowAtlasEdgeLimit(engine));
}

/** Whether tiles of `sizes` texels pack into an `edge`-texel atlas: largest first, power-of-two squares fill by area. */
function holdsTiles(edge: number, sizes: readonly number[]): boolean {
  return sizes.reduce((sum, size) => sum + size ** 2, 0) <= edge ** 2;
}

/**
 * The atlas edge a sun's cascades at map size `size` ask for (`cascadeTileSizes`): `edge`, the level's, while it holds
 * them; else the smallest larger power of two up to `limit` (`shadowAtlasEdgeLimit`) that does. Where none does, the
 * smallest that holds them at the largest smaller map size, to which admission halves the sun's map (an 8192 map falls
 * back to 4096 where the device makes no 16384 atlas). Local maps never grow it.
 *
 * Decided: the level's byte budget sizes the atlas for the level's own maps, and is admission policy, not a device
 * limit; a Directional Map Size past what that atlas holds is the author's explicit choice, honoured wherever the
 * device's limits allow, at the larger atlas's cost. The growth brings its own room in the ledgers
 * (`ShadowCost.exempt`), so it takes none from other allocations.
 */
export function sunShadowAtlasEdge(
  edge: number, limit: number, size: number, cascades: number, halved: number, firstScale: number,
): number {
  for (let mapSize = size; mapSize >= 256; mapSize /= 2)
    for (let grown = edge; grown <= limit; grown *= 2)
      if (holdsTiles(grown, cascadeTileSizes(mapSize, cascades, halved, firstScale, grown))) return grown;
  return edge;
}

/**
 * The page edge of an `edge`-texel atlas: half the edge (four pages), or the whole edge (one page) for an atlas made for a
 * tile that wide (`sizes`, the tiles placed as it is made), which no other tile can share. Every other tile is at most
 * half the edge (`cascadeTileSizes`, admission), so the pages hold exactly the tiles one quadtree over the whole edge
 * would, in the same places.
 */
export function shadowAtlasPageEdge(edge: number, sizes: readonly number[] = []): number {
  return edge > 1 && !sizes.some((size) => size >= edge) ? edge / 2 : edge;
}

type Atlas = { target: RenderTargetTexture; tiles: ShadowAtlasAllocator };
const atlases = new WeakMap<Scene, Atlas>();
const placeholders = new WeakMap<Scene, RenderTargetTexture>();
const generations = new WeakMap<Scene, number>();

/** What has been drawn into a Scene's atlas since it was first made: map passes, their tiles and the tiles' texels. */
export interface ShadowAtlasDrawCounts { maps: number; tiles: number; texels: number }
const drawCounts = new WeakMap<Scene, ShadowAtlasDrawCounts>();

/** How many atlases the Scene has made or taken over: it grows each time the Scene's atlas texture is created. */
export function shadowAtlasGeneration(scene: Scene): number {
  return generations.get(scene) ?? 0;
}

/** The Scene's cumulative atlas draws (`ShadowAtlasDrawCounts`); a reader takes the difference between two reads. */
export function shadowAtlasDrawCounts(scene: Scene): Readonly<ShadowAtlasDrawCounts> {
  let counts = drawCounts.get(scene);
  if (!counts) drawCounts.set(scene, counts = { maps: 0, tiles: 0, texels: 0 });
  return counts;
}

/** Disposes `target` with the Scene; `forget` runs once it is disposed, by the Scene or otherwise. */
function disposeWithScene(scene: Scene, target: RenderTargetTexture, forget: () => void): void {
  const sceneDisposed = scene.onDisposeObservable.addOnce(() => target.dispose());
  target.onDisposeObservable.addOnce(() => {
    scene.onDisposeObservable.remove(sceneDisposed);
    forget();
  });
}

/**
 * A depth-only render target of `edge` texels in pages of `page` (a depth texture array, one layer per page) whose
 * depth texture compares, as the light block samples it. The texture is its depth attachment: without
 * `generateDepthBuffer: false` Babylon's WebGL depth texture also allocates an unused depth renderbuffer of the same
 * size (64 MB at a 4096-texel atlas, 256 MB at 8192, 1 GiB at 16384), again each time the atlas is made.
 */
function depthTarget(name: string, edge: number, page: number, scene: Scene): RenderTargetTexture {
  const target = new RenderTargetTexture(name, { width: page, height: page, layers: (edge / page) ** 2 }, scene,
    { generateMipMaps: false, doNotChangeAspectRatio: true, noColorAttachment: true, generateDepthBuffer: false });
  const reverse = scene.getEngine().useReverseDepthBuffer;
  target.createDepthStencilTexture(reverse ? Constants.GREATER : Constants.LESS, true, false, 1, Constants.TEXTUREFORMAT_DEPTH32_FLOAT, name);
  return target;
}

/**
 * How long an atlas a disposed Scene left (`parkSceneAtlas`) waits for the next Scene of its Engine. Overlay Play
 * disposes the editor's Scene as it starts and the editor loads its Scene again as Play stops: the next Scene's first
 * shadow sync comes about one to four seconds later on a desktop and later on a phone.
 */
export const PARKED_SHADOW_ATLAS_MS = 10_000;

/**
 * An atlas whose Scene was disposed while it held no tile, kept for the next Scene of its Engine whose first atlas has
 * its edge and pages (`sceneAtlas`): one Engine-wide hand-over instead of a release and an allocation of the same size
 * (256 MiB at High) at every Play start and stop, which also spares the driver initialising a fresh texture on its first
 * use (a transient of about its size on ANGLE D3D11). It is the render target wrapper (framebuffer and depth texture
 * array), not the Scene's texture object. At most one is kept per Engine. It is freed by `discardParkedShadowAtlas`, after
 * `PARKED_SHADOW_ATLAS_MS`, on a context loss and with the Engine; no ledger counts it, as no Scene holds it.
 */
type ParkedAtlas = { wrapper: RenderTargetWrapper; edge: number; page: number; release: () => void };
const parked = new WeakMap<AbstractEngine, ParkedAtlas>();

/** The edge of the atlas parked on `engine` (`ParkedAtlas`), else 0. */
export function parkedShadowAtlasEdge(engine: AbstractEngine): number {
  return parked.get(engine)?.edge ?? 0;
}

/** Takes the atlas parked on `engine`, if any, out of its keeping: its timer and observers stop. */
function unpark(engine: AbstractEngine): ParkedAtlas | undefined {
  const kept = parked.get(engine);
  if (!kept) return undefined;
  parked.delete(engine);
  kept.release();
  return kept;
}

/**
 * Frees the atlas parked on `engine` unless its edge is `keepEdge` (0 frees any). True when it freed one: like an atlas of
 * another edge in its own Scene, the caller builds the new atlas in a later Engine frame, so the two never live in the
 * same frame.
 */
export function discardParkedShadowAtlas(engine: AbstractEngine, keepEdge = 0): boolean {
  const kept = parked.get(engine);
  if (!kept || kept.edge === keepEdge) return false;
  unpark(engine)!.wrapper.dispose();
  return true;
}

type TargetInternals = { _renderTarget: RenderTargetWrapper | null; _texture: unknown };

/**
 * Disposes the Scene's atlas texture as its Scene is disposed, parking its wrapper on the Engine (`ParkedAtlas`) while no
 * tile is in it and the context is live; otherwise it goes with the texture.
 */
function parkSceneAtlas(scene: Scene, atlas: Atlas): void {
  const engine = scene.getEngine();
  const wrapper = atlas.target.renderTarget;
  if (!wrapper || !atlas.tiles.empty || engine.isDisposed || (engine as unknown as { _contextWasLost: boolean })._contextWasLost) {
    atlas.target.dispose();
    return;
  }
  discardParkedShadowAtlas(engine);
  const target = atlas.target as unknown as TargetInternals;
  target._renderTarget = null;
  target._texture = null;
  atlas.target.dispose();
  const discard = () => {
    if (parked.get(engine)?.wrapper === wrapper) discardParkedShadowAtlas(engine);
  };
  const timer = setTimeout(discard, PARKED_SHADOW_ATLAS_MS);
  const lost = engine.onContextLostObservable.add(discard);
  const disposed = engine.onDisposeObservable.add(discard);
  parked.set(engine, {
    wrapper, edge: atlas.tiles.edge, page: atlas.tiles.pageEdge,
    release: () => {
      clearTimeout(timer);
      engine.onContextLostObservable.remove(lost);
      engine.onDisposeObservable.remove(disposed);
    },
  });
}

/**
 * The Scene's new atlas texture: the Engine's parked atlas (`ParkedAtlas`) when it has this edge and paging, behind a
 * texture of this Scene made as `depthTarget` makes one but allocating nothing, else a new one (a parked atlas of other
 * pages is freed first). Its depth is the last Scene's, which nothing samples: every map clears its tiles before its
 * first draw, and receivers sample a map neutrally until it has drawn (`neutralUntilRendered`).
 */
function takeAtlasTarget(scene: Scene, edge: number, page: number): RenderTargetTexture {
  const engine = scene.getEngine();
  const kept = parked.get(engine);
  if (!kept || kept.edge !== edge || kept.page !== page) {
    if (kept) discardParkedShadowAtlas(engine);
    return depthTarget("hapticShadowAtlas", edge, page, scene);
  }
  unpark(engine);
  const target = new RenderTargetTexture("hapticShadowAtlas", { width: page, height: page, layers: (edge / page) ** 2 }, scene,
    { generateMipMaps: false, doNotChangeAspectRatio: true, noColorAttachment: true, generateDepthBuffer: false, delayAllocation: true });
  const internals = target as unknown as TargetInternals;
  internals._renderTarget = kept.wrapper;
  internals._texture = kept.wrapper.texture;
  return target;
}

/**
 * The Scene's atlas at `edge` texels, made with its first tile (or taken over from the Engine's parked atlas,
 * `takeAtlasTarget`) and parked or disposed with the Scene (`parkSceneAtlas`), or replaced once no tile is left in it (a
 * quality level of another edge rebuilds every atlas map, whose allocation keys carry the edge; the shadow controller
 * releases the old atlas, its own or a parked one, an Engine frame before it builds into the new one, so this replaces
 * only an atlas it did not). A shadow allocation that fails disposes the textures it made, the atlas among them when
 * that tile was its first: the next tile makes it again.
 */
function sceneAtlas(scene: Scene, edge: number, sizes: readonly number[]): Atlas {
  const page = shadowAtlasPageEdge(edge, sizes);
  let atlas = atlases.get(scene);
  if (atlas && atlas.tiles.edge !== edge) {
    if (!atlas.tiles.empty) throw new Error(`The shadow atlas is ${atlas.tiles.edge} texels, not ${edge}, while it holds tiles.`);
    atlas.target.dispose();
    atlas = undefined;
  }
  // An empty atlas paged for other tiles is made again; one holding tiles has no room for a tile its pages refuse.
  if (atlas && atlas.tiles.pageEdge !== page && atlas.tiles.empty) {
    atlas.target.dispose();
    atlas = undefined;
  }
  if (!atlas) {
    const target = takeAtlasTarget(scene, edge, page);
    const made: Atlas = atlas = { target, tiles: new ShadowAtlasAllocator(edge, page) };
    atlases.set(scene, atlas);
    generations.set(scene, shadowAtlasGeneration(scene) + 1);
    const sceneDisposed = scene.onDisposeObservable.addOnce(() => parkSceneAtlas(scene, made));
    target.onDisposeObservable.addOnce(() => {
      scene.onDisposeObservable.remove(sceneDisposed);
      atlases.delete(scene);
    });
  }
  return atlas;
}

/** Disposes the Scene's atlas once it holds no tile, as its last map is released: its memory follows its use. */
export function releaseEmptyShadowAtlas(scene: Scene): void {
  const atlas = atlases.get(scene);
  if (atlas?.tiles.empty) atlas.target.dispose();
}

/** The edge of the Scene's atlas while it exists, else 0: its pages together, not one page (its texture's own size). */
export function liveShadowAtlasEdge(scene: Scene): number {
  return atlases.get(scene)?.tiles.edge ?? 0;
}

/** The bytes the Scene's atlas holds: none until its first tile. */
export function shadowAtlasBytes(scene: Scene): number {
  return liveShadowAtlasEdge(scene) ** 2 * SHADOW_ATLAS_BYTES_PER_TEXEL;
}

/** The render target every tile of the Scene's atlas draws into, or null before its first tile. */
export function shadowAtlasRenderTarget(scene: Scene): RenderTargetWrapper | null {
  return atlases.get(scene)?.target.renderTarget ?? null;
}

/**
 * What the light block samples its shadows from: the atlas once a light has a tile, else a one-texel, one-layer depth
 * target of the same kind. No light samples the stand-in. Its render size is a page's edge.
 */
export function shadowAtlasTexture(scene: Scene): RenderTargetTexture {
  const atlas = atlases.get(scene)?.target;
  if (atlas) return atlas;
  let placeholder = placeholders.get(scene);
  if (!placeholder) {
    placeholder = depthTarget("hapticShadowAtlasPlaceholder", 1, 1, scene);
    placeholders.set(scene, placeholder);
    disposeWithScene(scene, placeholder, () => placeholders.delete(scene));
  }
  return placeholder;
}

/**
 * A light's tiles as one render target: the atlas's framebuffer and depth texture, drawn one pass per tile (a sun's
 * cascades and a point light's faces are its layers), each bound to its tile's page of the atlas. It never owns the
 * atlas: disposing it leaves the framebuffer to the atlas.
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

  // A pass draws into its tile's page: that layer of the atlas.
  override _bindFrameBuffer(faceIndex = 0, layer = 0): void {
    super._bindFrameBuffer(faceIndex, this.tiles[layer]!.layer);
  }

  override getSize() {
    return { width: this.tiles[0]!.size, height: this.tiles[0]!.size };
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
 * Draws `map`'s passes into its tiles of `placed`, an atlas: each pass binds its tile's page, its viewport is its tile,
 * set once the framebuffer is bound (the object renderer sets the camera's before the bind), and its tile clears only
 * its own depth under a scissor, unless the page holds only tiles this render draws: then the page's first pass clears
 * the whole page (on a tile-based GPU a clear load action, nothing loaded) and its later passes none. `drawing(pass)`
 * runs as a pass starts, once Babylon's generator has set its view. Installed once the
 * generator has set its own observers. A real pass of a map in the Scene's atlas (one that clears; readiness probes
 * emit the other render events) is recorded in the Scene's shadow change journal (`recordShadowMapPass`) with its
 * tiles' drawn views, and partial when it skipped a caster that was not ready (Babylon resets the refresh counter).
 */
function drawIntoTiles(
  map: AtlasTileTarget, shadow: ShadowGenerator & AtlasShadow, placed: Atlas, drawing: (pass: number) => void,
  deferral?: { defers(pass: number): boolean; drawn(pass: number): void },
): void {
  const scene = map.getScene()!;
  const atlas = placed.target;
  const page = placed.tiles.pageEdge;
  const viewports = map.tiles.map((tile) => new Viewport(tile.x / page, tile.y / page, tile.size / page, tile.size / page));
  const whole = new Viewport(0, 0, 1, 1);
  const own = new Set(map.tiles);
  // The pages this render clears whole, and those it has cleared.
  const wholePages = new Set<number>();
  const clearedPages = new Set<number>();
  const views: { view: Matrix; reach: number }[] = map.tiles.map(() => ({ view: Matrix.Identity(), reach: 0 }));
  let pass = 0;
  let cleared = false;
  let partial = false;
  // A pass left out of this render (`deferral`): its tile keeps its depth and the view it was drawn with.
  let deferring = false;
  let deferred = false;
  map.ignoreCameraViewport = false;
  map.onBeforeRenderObservable.add((layer) => {
    pass = layer;
    if (layer === 0) {
      // A render's first pass: the pages it clears whole hold only its tiles, each of which it draws.
      wholePages.clear();
      clearedPages.clear();
      for (const tile of map.tiles) wholePages.add(tile.layer);
      map.tiles.forEach((tile, index) => {
        if (deferral?.defers(index) || !placed.tiles.holdsOnly(tile.layer, own)) wholePages.delete(tile.layer);
      });
    }
    scene.getEngine().setViewport(viewports[layer]!);
    deferring = deferral?.defers(layer) === true;
    if (deferring) {
      deferred = true;
      return;
    }
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
    if (deferring) return;
    cleared = true;
    deferral?.drawn(pass);
    const tile = map.tiles[pass]!;
    if (atlases.get(scene)?.target === atlas) {
      const counts = shadowAtlasDrawCounts(scene) as ShadowAtlasDrawCounts;
      counts.tiles += 1;
      counts.texels += tile.size * tile.size;
    }
    if (wholePages.has(tile.layer)) {
      // The page's first pass clears it whole, under a viewport over the page (a probe counts the texels it covers).
      if (clearedPages.has(tile.layer)) return;
      clearedPages.add(tile.layer);
      engine.setViewport(whole);
      engine.clear(null, false, true, false);
      engine.setViewport(viewports[pass]!);
      return;
    }
    engine.enableScissor(tile.x, tile.y, tile.size, tile.size);
    try {
      engine.clear(null, false, true, false);
    } finally {
      // A scissor left behind clips every later pass.
      engine.disableScissor();
    }
  });
  map.onAfterUnbindObservable.add(() => {
    // A render that left a pass out is incomplete: the map draws again next frame, when that pass is due.
    if (deferred && cleared) map.resetRefreshCounter();
    deferred = deferring = false;
    if (cleared) {
      // Only the Scene's atlas is sampled by its surfaces; a private one (caster warm-up) is not.
      if (atlases.get(scene)?.target === atlas) {
        (shadowAtlasDrawCounts(scene) as ShadowAtlasDrawCounts).maps += 1;
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
    const page = shadowAtlasPageEdge(edge);
    const target = depthTarget("hapticShadowAtlasPrivate", edge, page, scene);
    disposeWithScene(scene, target, () => {});
    return { target, tiles: new ShadowAtlasAllocator(edge, page) };
  } finally {
    entities._blockEntityCollection = blocked;
  }
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
 * The tile edge of each of a sun's `cascades` at map size `size` in an `edge`-texel atlas: the first takes `firstScale`
 * times the edge (`SHADOW_FIRST_CASCADE_SCALE`), the scale halved while that tile would be wider than half the atlas's
 * edge, down to the map size; the last `halved` take half the edge, never the first two, which hold the shadows near
 * the camera (the second starts a few metres out), down to the 256-texel floor admitted maps keep and never more than
 * `size` (a caster-variant stand-in's tiles are smaller still; `SHADOW_HALF_TILE_CASCADES`).
 *
 * The clamp keeps a Custom map size from asking for a first tile the atlas cannot hold beside the other cascades and
 * local maps (High's 2 at 8192 would be the whole 16384 atlas): it takes at most a quarter of the atlas, so at 8192 every
 * level's cascades leave at least three 4096 quadrants, room for the level's own local lights as spot maps; point
 * lights past that halve the sun as the reserve in `planShadowAdmission` says. The levels' own sizes keep their scale.
 */
export function cascadeTileSizes(size: number, cascades: number, halved: number, firstScale = 1, edge = Infinity): number[] {
  let scale = firstScale;
  while (scale > 1 && size * scale > edge / 2) scale /= 2;
  const full = Math.max(2, cascades - halved);
  const far = size > 256 ? Math.max(256, size / 2) : size;
  return Array.from({ length: cascades }, (_, index) => (index === 0 ? size * scale : index < full ? size : far));
}

/** Allocates tiles of `sizes` texels in the Scene's `edge`-texel atlas, or none when one does not fit. */
function place(scene: Scene, sizes: readonly number[], edge: number): Placement | null {
  const atlas = privateAtlas ?? sceneAtlas(scene, edge, sizes);
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

  /**
   * One depth program draws a caster for every local light. Babylon names the light's class in a define no shader
   * reads, and has a point light's casters write their distance to the light as colour, which the atlas has no
   * attachment for (it is depth only): without the first and with the second off, a spot light's tile and a point
   * light's faces ask a caster for the same defines, so the same program.
   */
  protected override _isReadyCustomDefines(defines: string[], subMesh: SubMesh, useInstances: boolean): void {
    super._isReadyCustomDefines(defines, subMesh, useInstances);
    for (let index = defines.length - 1; index >= 0; index -= 1) {
      const define = defines[index]!;
      if (define.startsWith("#define SM_LIGHTTYPE_")) defines.splice(index, 1);
      else if (define.startsWith("#define SM_USEDISTANCE ")) defines[index] = "#define SM_USEDISTANCE 0";
    }
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
    const near = -m[14]! / (m[10]! + 1);
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
    drawIntoTiles(this._shadowMap as AtlasTileTarget, this, this.placement.atlas, (face) => {
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

/** The first cascade `shadowdebug farcascades off` draws on alternate frames: the first two hold the near shadows. */
const FIRST_DEFERRED_CASCADE = 2;

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
  /**
   * Per cascade, whether its tile has been cleared and drawn since the map was made (`defersCascade`). Set as the map
   * is initialised, which Babylon's constructor does before this class's own fields would be.
   */
  declare private cascadeDrawn: boolean[];
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
      // Each cascade's own tile: the first's may be larger than the map size, the last ones' smaller.
      const tile = (this.placement.tiles[index] ?? this.placement.tiles[0]!).size;
      return { end, texelsPerMetre: width > 0 ? tile / width : 0 };
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

  /** Debug (`shadowdebug depthclamp off`): the casters' depth is clamped in the vertex stage (`shadow-vertex-clamp.ts`). */
  protected override _isReadyCustomDefines(defines: string[]): void {
    super._isReadyCustomDefines(defines);
    if (shadowDebugOff(this._scene, "depthclamp")) applyVertexDepthClamp(defines);
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
    const cascadeDrawn: boolean[] = this.cascadeDrawn = [];
    drawIntoTiles(this._shadowMap as AtlasTileTarget, this, this.placement.atlas, (cascade) => {
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
    }, { defers: (cascade) => this.defersCascade(cascade), drawn: (cascade) => { cascadeDrawn[cascade] = true; } });
  }

  /**
   * Debug (`shadowdebug farcascades off`): whether `cascade` is left out of a render in this Engine frame. The
   * cascades after the first two, once each has drawn, are cleared and drawn only in even Engine frames; in odd ones
   * their tiles keep their depth and `drawnViews` keeps the view that drew it, which receivers go on sampling with. A
   * render that left one out asks for another (`drawIntoTiles`), so a map that draws on change is whole a frame later.
   */
  defersCascade(cascade: number): boolean {
    return cascade >= FIRST_DEFERRED_CASCADE && this.cascadeDrawn[cascade] === true &&
      (this._scene.getEngine().frameId & 1) === 1 && shadowDebugOff(this._scene, "farcascades");
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
  light: DirectionalLight, size: number, cascades: number, edge: number, camera?: Camera, halved = 0, firstScale = 1,
): AtlasCascadedShadowGenerator | null {
  const placement = place(light.getScene(), cascadeTileSizes(size, cascades, halved, firstScale, edge), edge);
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
