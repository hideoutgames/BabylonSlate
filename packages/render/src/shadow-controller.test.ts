import { afterEach, describe, expect, it, vi } from "vitest";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { InternalTexture } from "@babylonjs/core/Materials/Textures/internalTexture";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { onSceneReadinessDirty } from "./scene-readiness-signal";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Scene } from "@babylonjs/core/scene";
import { ShadowDepthWrapper } from "@babylonjs/core/Materials/shadowDepthWrapper";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { sceneShadowController } from "./shadow-controller";
import { meshCastsShadows } from "./instance-pool";
import { isForwardLightExcluded, syncForwardLightPolicy } from "./light-policy";
import { selectHapticLights } from "./haptic-lights";
import { awaitsFirstDraw } from "./shadow-first-draw";
import { NEUTRAL_DARKNESS } from "./shadow-map-factory";
import {
  sceneRenderingSettings,
  updateSceneRenderingSettings,
} from "./render-settings";
import { normalizeShadowSettings, normalizeWaterBody, qualityPresetPatch, SHADOW_CAPACITY_PROFILES, SHADOW_FIRST_CASCADE_SCALE, SHADOW_HALF_TILE_CASCADES } from "@haptic/core";
import { ENGINE_SHADOW_BUDGET } from "./shadow-admission";
import { managedRenderReservations } from "./managed-render-resources";
import { unsupportedManagedShadows } from "./framegraph-managed-shadows";
import { createColliderVisualMesh } from "./collider-visual";
import { createWaterMesh } from "./water-mesh";
import { ShadowAtlasAllocator } from "./shadow-atlas-allocator";
import {
  AtlasCascadedShadowGenerator, AtlasShadowGenerator, cascadeTileSizes, holdShadowAtlasPages, isAtlasShadow, PARKED_SHADOW_ATLAS_MS, shadowAtlasBytes,
  shadowAtlasDrawCounts, shadowAtlasGeneration, shadowAtlasRenderTarget, shadowAtlasTexture,
} from "./shadow-atlas";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { Viewport } from "@babylonjs/core/Maths/math.viewport";
import { captureShadowDiagnostics } from "./shadow-diagnostics";
import { builtInWaterMaterial } from "./water-template";
import { PlanarMirrorCamera } from "./planar-mirror";

const engines: NullEngine[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const engine of engines.splice(0)) engine.dispose();
});
/** `beforeController` runs on the bare Scene, before anything observes its meshes. */
/** A NullEngine with the shipped Engine's shadow features, releasing textures from its cache as WebGL does. */
function shadowEngine(): NullEngine {
  const engine = new NullEngine();
  Object.assign(engine.getCaps(), {
    maxTexturesImageUnits: 16,
    maxTextureSize: 4096,
    maxCubemapTextureSize: 4096,
    textureHalfFloatRender: true,
    textureHalfFloatLinearFiltering: true,
  });
  // The shipped Engine draws cascades with hardware depth comparison: the sun's atlas map is one.
  engine._features.supportCSM = true;
  engine._features.supportShadowSamplers = true;
  // NullEngine also leaves _releaseTexture empty. Match WebGL cache ownership
  // so resource disposal assertions observe the same lifetime as a real GPU.
  engine._releaseTexture = (texture) => {
    const cache = engine.getLoadedTexturesCache();
    const index = cache.indexOf(texture);
    if (index !== -1) cache.splice(index, 1);
  };
  return engine;
}
function fixture(beforeController?: (scene: Scene) => void) {
  const engine = shadowEngine();
  engines.push(engine);
  const scene = new Scene(engine);
  scene.activeCamera = new UniversalCamera(
    "camera",
    new Vector3(0, 2, -10),
    scene,
  );
  updateSceneRenderingSettings(scene, {
    shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1 }),
  });
  beforeController?.(scene);
  return { scene, controller: sceneShadowController(scene) };
}

/** Run real RTT preparation/clear callbacks; NullEngine still does not prove pixels. */
function prepareShadowLayers(generator: ShadowGenerator): void {
  const scene = generator.getLight().getScene();
  scene.incrementRenderId();
  // Scene._renderForCamera prepares the receiver's projection before RTTs.
  // Native CSM consumes that cached matrix during its before-bind callback.
  scene.updateTransformMatrix(true);
  const map = generator.getShadowMap()!;
  map.render();
}

/**
 * Gives a NullEngine WebGL's framebuffer binding as Babylon's ThinEngine keeps it (`_currentFramebuffer`, a bind only
 * when it changes, a layer attached at every bind), recording the GL calls it makes.
 */
function recordFramebuffers(engine: AbstractEngine): string[] {
  const gl: string[] = [];
  const binding = engine as unknown as {
    _currentFramebuffer: { name: string } | null; _cachedViewport: Viewport | null; _bindUnboundFramebuffer(framebuffer: { name: string } | null): void;
  };
  binding._currentFramebuffer = null;
  binding._bindUnboundFramebuffer = (framebuffer) => {
    if (binding._currentFramebuffer === framebuffer) return;
    gl.push(`bind ${framebuffer?.name ?? "default"}`);
    binding._currentFramebuffer = framebuffer;
  };
  engine.bindFramebuffer = (target, _face, width, height, full, _lod, layer = 0) => {
    engine._currentRenderTarget = target;
    binding._bindUnboundFramebuffer((target as unknown as { _framebuffer?: { name: string } })._framebuffer ?? null);
    gl.push(`attach ${layer}`);
    if (binding._cachedViewport && !full) engine.setViewport(binding._cachedViewport, width, height);
  };
  engine.unBindFramebuffer = (_target, _mips, before) => {
    engine._currentRenderTarget = null;
    before?.();
    binding._bindUnboundFramebuffer(null);
  };
  return gl;
}

/** The edge of what the light block samples: its pages' edge times their count along an edge (the stand-in's is 1). */
function atlasTextureEdge(scene: Scene): number {
  const texture = shadowAtlasTexture(scene);
  return texture.getRenderSize() * Math.sqrt(texture.getRenderLayers());
}

/** Ends the Engine frame, as the render loop does after each frame it draws. */
function endFrame(scene: Scene): void {
  const engine = scene.getEngine();
  engine.beginFrame();
  engine.endFrame();
}

/** An atlas map's tile sizes, one per cascade or face. */
const tileSizes = (generator: unknown) => (generator as AtlasCascadedShadowGenerator | AtlasShadowGenerator).tiles.map((tile) => tile.size);

/** A cascade's world texel in a `size`-texel tile: the larger side of its light-space box over the tile. */
function cascadeTexel(generator: CascadedShadowGenerator, layer: number, size: number): number {
  const min = generator.getCascadeMinExtents(layer)!;
  const max = generator.getCascadeMaxExtents(layer)!;
  return Math.max(max.x - min.x, max.y - min.y) / size;
}

/** The automatic depth bias of a cascade: a quarter texel over its depth range, for depth-clamped PCF. */
function cascadeDepthBias(generator: CascadedShadowGenerator, layer: number, size: number, authored: number): number {
  const depth = generator.getCascadeMaxExtents(layer)!.z - generator.getCascadeMinExtents(layer)!.z;
  return Math.max(authored, Math.min(0.05, cascadeTexel(generator, layer, size) / 4 / depth / 1.5));
}

it("stales readiness for a new mesh only when it comes to cast or receive", async () => {
  const { scene, controller } = fixture();
  controller.sync();
  const marks: string[] = [];
  const scopes: (readonly AbstractMesh[] | undefined)[] = [];
  onSceneReadinessDirty(scene, (reason, scope) => {
    marks.push(reason);
    if (reason === "shadowCasters") scopes.push(scope);
  });
  const settle = async () => {
    // Babylon announces an added mesh on a later task; the next sync applies what is pending.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.sync();
  };
  // A particle emitter's anchor neither casts nor receives: it comes out of the sync as it went in.
  new Mesh("particleEmitter:spark", scene);
  await settle();
  expect(marks).not.toContain("shadowCasters");
  // A mesh that joins the casters and receives changes its Material's variant and the maps' lists.
  const crate = MeshBuilder.CreateBox("crate", {}, scene);
  await settle();
  expect(marks.filter((reason) => reason === "shadowCasters")).toHaveLength(1);
  // Only that mesh's variants and its maps' lists changed: a steady frame probes it alone.
  expect(scopes.map((scope) => [...new Set(scope)])).toEqual([[crate]]);
  // Nothing pending: nothing more.
  controller.sync();
  expect(marks.filter((reason) => reason === "shadowCasters")).toHaveLength(1);
});

describe("shared shadow lifecycle", () => {
  it("draws the sun's cascades as tiles of the light block's atlas, built with the level's cascade count", () => {
    const { scene, controller } = fixture();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 3, maxLocalLights: 1 }) });
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    controller.register(sun, true);
    controller.sync();
    const generator = sun.getShadowGenerator() as AtlasCascadedShadowGenerator;
    expect(generator).toBeInstanceOf(AtlasCascadedShadowGenerator);
    expect(generator.numCascades).toBe(3);
    // Medium's three 2048 cascades in its 4096 atlas, the last in a tile of half that edge.
    expect(generator.tiles.map((tile) => tile.size)).toEqual([2048, 2048, 1024]);
    expect(controller.metrics().bytes).toBe(shadowAtlasBytes(scene));
    // One cascade, which Babylon's own count could not be.
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1 }) });
    controller.sync();
    const single = sun.getShadowGenerator() as AtlasCascadedShadowGenerator;
    expect(single).not.toBe(generator);
    expect([single.numCascades, single.tiles.length]).toEqual([1, 1]);
  });

  it("draws the sun's far cascades in every second frame only while `shadowdebug farcascades` is off, each keeping the view that drew it", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 4, maxLocalLights: 1 }) });
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    controller.register(sun, true);
    controller.sync();
    const generator = sun.getShadowGenerator() as AtlasCascadedShadowGenerator;
    const camera = scene.activeCamera!;
    // The tiles a render cleared, by cascade: each is alone in its page, which its pass clears whole.
    const passes: number[] = [];
    let pass = -1;
    generator.getShadowMap()!.onBeforeRenderObservable.add((layer) => { pass = layer; });
    vi.spyOn(engine, "clear").mockImplementation(() => { passes.push(pass); });
    const cleared = () => {
      passes.length = 0;
      prepareShadowLayers(generator);
      return [...passes];
    };
    const views = () => generator.drawnViews.map((view) => view.m.join());
    const frame = (id: number) => { (engine as unknown as { _frameId: number })._frameId = id; };
    // The default: every cascade in every frame, odd or even.
    frame(1);
    expect(cleared()).toEqual([0, 1, 2, 3]);
    expect(controller.setDebug("farcascades", false)).toBe(true);
    // An even frame draws them all.
    frame(2);
    camera.position.x += 3;
    expect(cleared()).toEqual([0, 1, 2, 3]);
    const even = views();
    // An odd frame leaves the far two out: their tiles are not cleared, and they keep the view that drew them while
    // the near two follow the camera.
    frame(3);
    camera.position.x += 3;
    expect(generator.defersCascade(1)).toBe(false);
    expect(generator.defersCascade(2)).toBe(true);
    expect(cleared()).toEqual([0, 1]);
    const odd = views();
    expect([odd[0] === even[0], odd[1] === even[1], odd[2] === even[2], odd[3] === even[3]]).toEqual([false, false, true, true]);
    // That render was incomplete: the map is due again in the next frame, which draws the far ones where the camera is.
    expect((generator.getShadowMap() as unknown as { _objectRenderer: { _currentRefreshId: number } })._objectRenderer._currentRefreshId).toBe(-1);
    frame(4);
    expect(cleared()).toEqual([0, 1, 2, 3]);
    expect(views()[3]).not.toBe(even[3]);
    // Switched back on, odd frames draw every cascade again.
    controller.setDebug("farcascades", true);
    frame(5);
    expect(cleared()).toEqual([0, 1, 2, 3]);
  });

  it("draws each pass into its tile's page, clearing a page whole when it holds only the tiles the render draws", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ maxLocalLights: 2 }) });
    const lamp = new PointLight("lamp", new Vector3(0, 2, 0), scene);
    controller.register(lamp, true);
    controller.sync();
    const generator = lamp.getShadowGenerator() as AtlasShadowGenerator;
    // Medium's 4096 atlas is four 2048 pages: four 1024 faces fill the first, the last two take half of the second.
    expect(atlasTextureEdge(scene)).toBe(4096);
    expect(shadowAtlasTexture(scene).getRenderLayers()).toBe(4);
    expect(generator.tiles.map((tile) => tile.layer)).toEqual([0, 0, 0, 0, 1, 1]);
    let pass = -1;
    generator.getShadowMap()!.onBeforeRenderObservable.add((layer) => { pass = layer; });
    const bound: number[] = [];
    const bind = engine.bindFramebuffer.bind(engine);
    vi.spyOn(engine, "bindFramebuffer").mockImplementation((target, face, width, height, full, lod, layer) => {
      if (target === shadowAtlasTexture(scene).renderTarget) bound.push(layer ?? 0);
      bind(target, face, width, height, full, lod, layer);
    });
    const clears: string[] = [];
    let scissored = false;
    vi.spyOn(engine, "enableScissor").mockImplementation(() => { scissored = true; });
    vi.spyOn(engine, "disableScissor").mockImplementation(() => { scissored = false; });
    vi.spyOn(engine, "clear").mockImplementation(() => { clears.push(`${pass}${scissored ? " tile" : " page"}`); });
    const render = () => {
      bound.length = clears.length = 0;
      prepareShadowLayers(generator);
      return { bound: [...bound], clears: [...clears] };
    };
    // Its own pages: each cleared whole by its first pass, nothing loaded of another light's.
    expect(render()).toEqual({ bound: [0, 0, 0, 0, 1, 1], clears: ["0 page", "4 page"] });
    // A spot light's tile joins the second page: the faces there clear only their own tiles.
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, scene);
    controller.register(spot, true);
    controller.sync();
    expect((spot.getShadowGenerator() as AtlasShadowGenerator).tile.layer).toBe(1);
    expect(render().clears).toEqual(["0 page", "4 tile", "5 tile"]);
  });

  it("binds an atlas page once for consecutive tile passes on it, across the maps of a shadow stage", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ maxLocalLights: 2 }) });
    const lamp = new PointLight("lamp", new Vector3(0, 2, 0), scene);
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, scene);
    controller.register(lamp, true);
    controller.register(spot, true);
    controller.sync();
    const faces = lamp.getShadowGenerator() as AtlasShadowGenerator, tile = spot.getShadowGenerator() as AtlasShadowGenerator;
    // Four faces fill the first page; the last two and the spot light's tile share the second.
    expect([...faces.tiles.map((entry) => entry.layer), tile.tile.layer]).toEqual([0, 0, 0, 0, 1, 1, 1]);
    const gl = recordFramebuffers(engine);
    const atlas = shadowAtlasTexture(scene).renderTarget as unknown as { _framebuffer: unknown };
    atlas._framebuffer = { name: "atlas" };
    const ended: string[] = [];
    faces.getShadowMap()!.onAfterRenderObservable.add((face) => ended.push(`face ${face}`));
    tile.getShadowMap()!.onAfterRenderObservable.add(() => ended.push("spot"));
    const passes = () => shadowAtlasDrawCounts(scene).passes;
    // One map: the second page is attached without binding the framebuffer again, and the render ends unbound.
    let before = passes();
    prepareShadowLayers(faces);
    expect(gl.splice(0)).toEqual(["bind atlas", "attach 0", "attach 1", "bind default"]);
    expect(passes() - before).toBe(2);
    expect(engine._currentRenderTarget).toBeNull();
    // Each pass's end is still told, its clear and its viewport still its tile's.
    expect(ended.splice(0)).toEqual(["face 0", "face 0", "face 0", "face 0", "face 0", "face 0"]);
    // A stage: the spot light's tile follows the faces on the second page without a bind; the stage ends unbound.
    before = passes();
    const stage = holdShadowAtlasPages(scene);
    prepareShadowLayers(faces);
    prepareShadowLayers(tile);
    expect(gl).toEqual(["bind atlas", "attach 0", "attach 1"]);
    stage.release();
    expect(gl.splice(0)).toEqual(["bind atlas", "attach 0", "attach 1", "bind default"]);
    expect(passes() - before).toBe(2);
    expect(ended.splice(0)).toHaveLength(7);
    expect(engine._currentRenderTarget).toBeNull();
    // Anything bound between the maps ends the hold: the next map binds its page again.
    const other = { _framebuffer: { name: "other" } };
    const again = holdShadowAtlasPages(scene);
    prepareShadowLayers(faces);
    engine.bindFramebuffer(other as never);
    engine.unBindFramebuffer(other as never);
    prepareShadowLayers(tile);
    again.release();
    expect(gl.splice(0)).toEqual([
      "bind atlas", "attach 0", "attach 1", "bind other", "attach 0", "bind default", "bind atlas", "attach 1", "bind default",
    ]);
    expect(engine._currentRenderTarget).toBeNull();
    // A map drawn outside a stage after it ends its render unbound, as Babylon's does.
    prepareShadowLayers(tile);
    expect(gl.splice(0)).toEqual(["bind atlas", "attach 1", "bind default"]);
  });

  it("gives a level's first cascade its larger tile and its last cascades tiles of half the edge, never the first two and never below the floor", () => {
    expect((["low", "medium", "high", "ultra"] as const).map((level) =>
      cascadeTileSizes(2048, 4, SHADOW_HALF_TILE_CASCADES[level], SHADOW_FIRST_CASCADE_SCALE[level]))).toEqual([
      [2048, 2048, 2048, 2048], [2048, 2048, 2048, 1024], [4096, 2048, 2048, 1024], [2048, 2048, 1024, 1024],
    ]);
    // The first two hold the near shadows; a 256 tile is the floor; a stand-in's smaller tiles stay as they are.
    expect([cascadeTileSizes(2048, 1, 2), cascadeTileSizes(2048, 2, 2), cascadeTileSizes(2048, 3, 2), cascadeTileSizes(512, 3, 1),
      cascadeTileSizes(256, 3, 1), cascadeTileSizes(64, 3, 1)])
      .toEqual([[2048], [2048, 2048], [2048, 2048, 1024], [512, 512, 256], [256, 256, 256], [64, 64, 64]]);
  });

  it("snaps a cascade drawn into a half-edge tile to that tile's texels as the camera moves", () => {
    const { scene, controller } = fixture();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 3, maxLocalLights: 1 }) });
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    controller.register(sun, true);
    controller.sync();
    const generator = sun.getShadowGenerator() as AtlasCascadedShadowGenerator;
    const camera = scene.activeCamera!;
    // Where the world origin lands, in the last cascade's texels: stabilised cascades put it on a texel corner.
    const originTexels = () => {
      generator.getShadowMap()!.onBeforeBindObservable.notifyObservers(generator.getShadowMap()!);
      const origin = Vector3.TransformCoordinates(Vector3.Zero(), generator.getCascadeTransformMatrix(2)!);
      return [origin.x, origin.y].map((value) => value * generator.tiles[2]!.size / 2);
    };
    for (let step = 0; step < 8; step++) {
      camera.position.x += 0.37;
      for (const texel of originTexels()) expect(Math.abs(texel - Math.round(texel))).toBeLessThan(1e-3);
    }
  });

  it("builds the sun's cascades while another Engine is the last created, as a model conversion's NullEngine is", () => {
    const { scene, controller } = fixture();
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    controller.register(sun, true);
    // Babylon's cascade constructor asks the last-created Engine, which cannot draw cascades.
    const conversion = new NullEngine();
    engines.push(conversion);
    controller.sync();
    expect(sun.getShadowGenerator()).toBeInstanceOf(AtlasCascadedShadowGenerator);
    expect(controller.diagnostics()[0]?.status).toBe("active");
  });

  it("draws a point light's shadow as six face tiles of the light block's atlas, filtered with PCF", () => {
    const { scene, controller } = fixture();
    const lamp = new PointLight("lamp", new Vector3(0, 2, 0), scene);
    controller.register(lamp, true);
    controller.sync();
    const generator = lamp.getShadowGenerator() as AtlasShadowGenerator;
    expect(generator).toBeInstanceOf(AtlasShadowGenerator);
    // Medium's 1024 local maps, one per face.
    expect(generator.tiles.map((tile) => tile.size)).toEqual([1024, 1024, 1024, 1024, 1024, 1024]);
    expect(generator.usePercentageCloserFiltering).toBe(true);
    expect(controller.diagnostics()[0]?.passes).toBe(6);
  });

    it("draws spot maps as tiles of the light block's atlas, rebuilt for another atlas edge and released with the last", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    Object.assign(engine.getCaps(), { maxTextureSize: 8192 });
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, scene);
    controller.register(spot, true);
    controller.sync();
    const medium = spot.getShadowGenerator();
    expect(medium).toBeInstanceOf(AtlasShadowGenerator);
    expect(atlasTextureEdge(scene)).toBe(4096);
    expect(controller.metrics().bytes).toBe(shadowAtlasBytes(scene));
    // High's byte budget holds an atlas of 8192: the map is rebuilt in it, from the frame after the old atlas went.
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ profile: "high", cascades: 1, maxLocalLights: 1 }) });
    controller.sync();
    endFrame(scene);
    controller.sync();
    const high = spot.getShadowGenerator() as AtlasShadowGenerator;
    expect(high).toBeInstanceOf(AtlasShadowGenerator);
    expect(high).not.toBe(medium);
    expect(atlasTextureEdge(scene)).toBe(8192);
    expect(high.tile.size).toBe(2048);
    // With the last map the atlas goes.
    controller.register(spot, false);
    controller.sync();
    expect(shadowAtlasBytes(scene)).toBe(0);
    expect(atlasTextureEdge(scene)).toBe(1);
  });
  describe("an atlas handed from a disposed Scene to the next Scene of its Engine", () => {
    /** Another Scene on `engine`, set up as the fixture's, with a sun that asks for shadows unless `asks` is false. */
    function nextScene(engine: NullEngine, profile: "medium" | "high" = "medium", asks = true) {
      const scene = new Scene(engine);
      scene.activeCamera = new UniversalCamera("camera", new Vector3(0, 2, -10), scene);
      updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ profile, cascades: 1, maxLocalLights: 1 }) });
      const controller = sceneShadowController(scene);
      const sun = new DirectionalLight("sun", Vector3.Down(), scene);
      controller.register(sun, asks);
      return { scene, controller, sun };
    }
    /** Counts the atlas depth textures made (each allocates the whole atlas). */
    function countAtlasAllocations(): { made: number } {
      const count = { made: 0 };
      const makeDepth = RenderTargetTexture.prototype.createDepthStencilTexture;
      vi.spyOn(RenderTargetTexture.prototype, "createDepthStencilTexture").mockImplementation(function (
        this: RenderTargetTexture, ...args: Parameters<typeof makeDepth>
      ) {
        if (this.name === "hapticShadowAtlas") count.made += 1;
        return makeDepth.apply(this, args);
      });
      return count;
    }
    /** Textures the Engine has released (`_releaseTexture`: an InternalTexture's last reference went). */
    const released = new WeakSet<InternalTexture>();
    function watchReleases(engine: NullEngine): NullEngine {
      const release = engine._releaseTexture.bind(engine);
      engine._releaseTexture = (texture) => {
        released.add(texture);
        release(texture);
      };
      return engine;
    }
    const live = (_engine: NullEngine, texture: InternalTexture | null) => texture !== null && !released.has(texture);

    it("draws the next Scene's maps into the same depth texture, allocating no second atlas, and again after that Scene goes", () => {
      const allocations = countAtlasAllocations();
      const first = nextScene(watchReleases(shadowEngine()));
      const engine = first.scene.getEngine() as NullEngine;
      first.controller.sync();
      const wrapper = shadowAtlasTexture(first.scene).renderTarget!;
      const depth = wrapper.depthStencilTexture;
      expect([allocations.made, live(engine, depth)]).toEqual([1, true]);
      first.scene.dispose();
      // Parked: no Scene holds it, and its depth texture lives on.
      expect(live(engine, depth)).toBe(true);

      const second = nextScene(engine);
      second.controller.sync();
      const map = second.controller.generator(second.sun)!.getShadowMap()!;
      expect(shadowAtlasTexture(second.scene).getScene()).toBe(second.scene);
      expect(shadowAtlasTexture(second.scene).renderTarget).toBe(wrapper);
      expect(map.renderTarget).toBe(wrapper);
      expect(shadowAtlasBytes(second.scene)).toBe(4096 ** 2 * 4);
      expect(allocations.made).toBe(1);

      second.scene.dispose();
      const third = nextScene(engine);
      third.controller.sync();
      expect([shadowAtlasTexture(third.scene).renderTarget, allocations.made, live(engine, depth)]).toEqual([wrapper, 1, true]);
      // With its last Scene the Engine frees it.
      third.scene.dispose();
      engine.dispose();
      expect(live(engine, depth)).toBe(false);
    });

    it("frees a parked atlas no Scene takes within PARKED_SHADOW_ATLAS_MS, and the next Scene makes its own", () => {
      vi.useFakeTimers();
      try {
        const allocations = countAtlasAllocations();
        const { scene, controller } = fixture();
        const engine = watchReleases(scene.getEngine() as NullEngine);
        const sun = new DirectionalLight("sun", Vector3.Down(), scene);
        controller.register(sun, true);
        controller.sync();
        const depth = shadowAtlasTexture(scene).renderTarget!.depthStencilTexture;
        scene.dispose();
        vi.advanceTimersByTime(PARKED_SHADOW_ATLAS_MS - 1);
        expect(live(engine, depth)).toBe(true);
        vi.advanceTimersByTime(1);
        expect(live(engine, depth)).toBe(false);
        const next = nextScene(engine);
        next.controller.sync();
        expect([allocations.made, shadowAtlasBytes(next.scene)]).toEqual([2, 4096 ** 2 * 4]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("frees a parked atlas of another edge in one frame and makes the new one in a later frame", () => {
      const allocations = countAtlasAllocations();
      const first = nextScene(watchReleases(shadowEngine()), "high");
      const engine = first.scene.getEngine() as NullEngine;
      engines.push(engine);
      Object.assign(engine.getCaps(), { maxTextureSize: 8192 });
      first.controller.sync();
      const depth = shadowAtlasTexture(first.scene).renderTarget!.depthStencilTexture;
      expect(shadowAtlasBytes(first.scene)).toBe(8192 ** 2 * 4);
      first.scene.dispose();
      endFrame(first.scene);

      const second = nextScene(engine, "medium");
      second.controller.sync();
      expect([live(engine, depth), shadowAtlasBytes(second.scene), allocations.made]).toEqual([false, 0, 1]);
      expect(second.controller.diagnostics().map(({ status, reason }) => ({ status, reason })))
        .toEqual([{ status: "budget-limited", reason: "shadow atlas resizing" }]);
      endFrame(second.scene);
      second.controller.sync();
      expect([shadowAtlasBytes(second.scene), allocations.made]).toEqual([4096 ** 2 * 4, 2]);
    });

    it("frees a parked atlas when the next Scene to sync asks for no shadow", () => {
      const first = nextScene(watchReleases(shadowEngine()));
      const engine = first.scene.getEngine() as NullEngine;
      engines.push(engine);
      first.controller.sync();
      const depth = shadowAtlasTexture(first.scene).renderTarget!.depthStencilTexture;
      first.scene.dispose();
      const second = nextScene(engine, "medium", false);
      second.controller.sync();
      expect([live(engine, depth), shadowAtlasBytes(second.scene)]).toEqual([false, 0]);
    });
  });
  it("frees the atlas of a changed edge in one frame and makes the new one in a later frame, never in the same one", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    Object.assign(engine.getCaps(), { maxTextureSize: 8192 });
    // Every Scene atlas made and freed, with the Engine frame it happened in.
    const events: string[] = [];
    const makeDepth = RenderTargetTexture.prototype.createDepthStencilTexture;
    vi.spyOn(RenderTargetTexture.prototype, "createDepthStencilTexture").mockImplementation(function (
      this: RenderTargetTexture, ...args: Parameters<typeof makeDepth>
    ) {
      if (this.name === "hapticShadowAtlas") {
        const edge = this.getRenderSize() * Math.sqrt(this.getRenderLayers());
        events.push(`frame ${engine.frameId}: make ${edge}`);
        this.onDisposeObservable.addOnce(() => events.push(`frame ${engine.frameId}: free ${edge}`));
      }
      return makeDepth.apply(this, args);
    });
    const level = (profile: "medium" | "high") => updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ profile, cascades: 1, maxLocalLights: 1 }),
    });
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, scene);
    controller.register(sun, true);
    controller.register(spot, true);
    level("high");
    controller.sync();
    expect(shadowAtlasBytes(scene)).toBe(8192 ** 2 * 4);
    endFrame(scene);
    // High to Medium: the 8192 atlas goes with its maps, and nothing is built for the rest of the frame.
    level("medium");
    controller.sync();
    controller.sync("admission");
    expect([controller.generator(sun), controller.generator(spot), shadowAtlasBytes(scene)]).toEqual([null, null, 0]);
    expect(controller.diagnostics().map(({ name, status, reason }) => ({ name, status, reason }))).toEqual([
      { name: "sun", status: "budget-limited", reason: "shadow atlas resizing" },
      { name: "spot", status: "budget-limited", reason: "shadow atlas resizing" },
    ]);
    expect(managedRenderReservations(engine)).toMatchObject({ shadowBytes: 0 });
    endFrame(scene);
    controller.sync();
    expect(controller.diagnostics().map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: "active", reason: null }, { status: "active", reason: null },
    ]);
    expect(shadowAtlasBytes(scene)).toBe(4096 ** 2 * 4);
    endFrame(scene);
    // And back to High.
    level("high");
    controller.sync();
    expect(shadowAtlasBytes(scene)).toBe(0);
    endFrame(scene);
    controller.sync();
    expect(tileSizes(controller.generator(spot))).toEqual([2048]);
    expect(events).toEqual([
      "frame 0: make 8192", "frame 1: free 8192", "frame 2: make 4096", "frame 3: free 4096", "frame 4: make 8192",
    ]);
  });
  it("releases a standby map of another atlas edge with the atlas instead of keeping it for reuse", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    Object.assign(engine.getCaps(), { maxTextureSize: 16384 });
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ ...qualityPresetPatch("high").shadows, mapSize: 8192 }) });
    const camera = scene.activeCamera!;
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, scene);
    spot.range = 10;
    controller.register(sun, true);
    controller.register(spot, true);
    controller.sync();
    // The 8192 sun grows the atlas to 16384; the spot light's map stands by there once the camera leaves its reach.
    expect(atlasTextureEdge(scene)).toBe(16384);
    camera.position.x = 1000;
    endFrame(scene);
    controller.sync();
    expect(controller.diagnostics([spot])[0]!.status).toBe("outside-relevant-area");
    expect(controller.boundGenerator(spot)).not.toBeNull();
    // Without the sun the atlas is High's 8192, where the standby map's tile is not: map and atlas go now.
    controller.register(sun, false);
    endFrame(scene);
    controller.sync();
    expect([controller.boundGenerator(spot), shadowAtlasBytes(scene)]).toEqual([null, 0]);
    // Back in reach, the map is built in an 8192 atlas.
    camera.position.x = 0;
    endFrame(scene);
    controller.sync();
    expect(controller.diagnostics([spot])[0]!.status).toBe("active");
    expect(atlasTextureEdge(scene)).toBe(8192);
  });
  it("excludes collider display segments without excluding authored meshes below the collider", () => {
    const { scene, controller } = fixture();
    const sun = new DirectionalLight("sun", new Vector3(0.35, -1, 0.2), scene);
    const collider = createColliderVisualMesh(scene, "mannequin-collider", {
      kind: "capsule", radius: 0.5, halfHeight: 1,
    });
    const dashes = collider.getChildMeshes();
    const model = MeshBuilder.CreateBox("authored-child", {}, scene);
    model.parent = collider;
    controller.setParticipation(collider, { castShadows: true, receiveShadows: true });
    controller.register(sun, true);
    controller.sync();
    const generator = controller.generator(sun)!;
    expect(dashes.length).toBeGreaterThan(0);
    expect(generator.getShadowMap()!.renderList).toContain(model);
    expect(dashes.filter(dash => generator.getShadowMap()!.renderList!.includes(dash))).toEqual([]);
    // Showing/hiding selection helpers must not recreate a map or drop the model.
    for (const visible of [false, true]) {
      for (const dash of dashes) dash.setEnabled(visible);
      controller.sync();
      expect(controller.generator(sun)).toBe(generator);
      expect(generator.getShadowMap()!.renderList).toContain(model);
      expect(dashes.some(dash => generator.getShadowMap()!.renderList!.includes(dash))).toBe(false);
    }
  });
  it("admits the Ultra sun at its requested 4096 within the Ultra memory budget", () => {
    const { scene, controller } = fixture();
    // A desktop texture limit: Ultra's byte budget holds an 8192 atlas, which its four 4096 cascades fill.
    Object.assign(scene.getEngine().getCaps(), { maxTextureSize: 16384 });
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings(qualityPresetPatch("ultra").shadows) });
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    controller.register(sun, true);
    controller.sync();
    expect(controller.generator(sun), JSON.stringify(controller.diagnostics())).not.toBeNull();
    expect(controller.diagnostics().find((entry) => entry.name === "sun")).toMatchObject({ status: "active", mapSize: 4096, reason: null });
    // Its last two cascades in tiles of half that edge.
    expect(tileSizes(controller.generator(sun))).toEqual([4096, 4096, 2048, 2048]);
    expect(controller.metrics().bytes).toBe(8192 ** 2 * 4);
    expect(controller.metrics().bytes).toBeLessThanOrEqual(SHADOW_CAPACITY_PROFILES.ultra.byteBudget);
    expect(sceneRenderingSettings(scene).shadows).toMatchObject({ profile: "ultra", preset: "ultra", mapSize: 4096, cascades: 4, maxLocalLights: 8 });
  });
  // The sun, admitted first, leaves the atlas room for the planned point light's six faces at the level's local size:
  // Medium's 4096 atlas keeps 10.5 M texels for its three 2048 cascades (9.4 M, the last at half edge), High's 8192
  // atlas 41.9 M for four 2048 ones (26.2 M, the first at twice and the last at half edge), and Ultra's exactly the
  // 41.9 M its four 4096 ones take, its last two at half edge.
  it.each([
    ["medium", 2048, [2048, 2048, 1024]],
    ["high", 2048, [4096, 2048, 2048, 1024]],
    ["ultra", 4096, [4096, 4096, 2048, 2048]],
  ] as const)("admits the %s sun beside a local shadow light at the largest cascades the atlas holds after the light's faces (%i)", (level, mapSize, tiles) => {
    const { scene, controller } = fixture();
    Object.assign(scene.getEngine().getCaps(), { maxTextureSize: 16384 });
    const shadows = normalizeShadowSettings(qualityPresetPatch(level).shadows);
    updateSceneRenderingSettings(scene, { shadows });
    const sun = new DirectionalLight("sun", Vector3.Down(), scene);
    controller.register(sun, true);
    controller.register(new PointLight("point", Vector3.Zero(), scene), true);
    controller.sync();
    expect(controller.diagnostics().find((entry) => entry.name === "sun")).toMatchObject({
      status: "active",
      mapSize,
      reason: mapSize < shadows.mapSize ? "shadow map reduced by shadow atlas space" : null,
    });
    expect(tileSizes(controller.generator(sun))).toEqual(tiles);
    expect(controller.diagnostics().find((entry) => entry.name === "point")).toMatchObject({
      status: "active", mapSize: shadows.localMapSize, reason: null,
    });
  });
  describe("an 8192 Directional Map Size", () => {
    const MIB = 1024 ** 2;
    /** High's shadows with the sun's map at 8192, a Custom choice. */
    const highAt8192 = () => normalizeShadowSettings({ ...qualityPresetPatch("high").shadows, mapSize: 8192 });

    it("grows the atlas to 16384 for the sun's cascades, its growth raising the ledger's ceiling, and goes back without it", () => {
      const { scene, controller } = fixture();
      const engine = scene.getEngine();
      Object.assign(engine.getCaps(), { maxTextureSize: 16384 });
      updateSceneRenderingSettings(scene, { shadows: highAt8192() });
      const sun = new DirectionalLight("sun", Vector3.Down(), scene);
      const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, scene);
      controller.register(sun, true);
      controller.register(spot, true);
      controller.sync();
      expect(sceneRenderingSettings(scene).shadows).toMatchObject({ profile: "high", preset: "custom", mapSize: 8192 });
      // The first cascade keeps the map size: twice it would be the whole atlas.
      expect(tileSizes(controller.generator(sun))).toEqual([8192, 8192, 8192, 4096]);
      expect(tileSizes(controller.generator(spot))).toEqual([2048]);
      expect(atlasTextureEdge(scene)).toBe(16384);
      expect(controller.metrics().bytes).toBe(1024 * MIB);
      // The 768 MiB past High's own 8192 atlas bring their own room.
      expect(managedRenderReservations(engine)).toMatchObject({ shadowBytes: 1024 * MIB, shadowExemptBytes: 768 * MIB, limit: 1792 * MIB });
      // Without the sun the spot map goes with the 16384 atlas, and is built in High's 8192 one from the next frame.
      controller.register(sun, false);
      controller.sync();
      expect(managedRenderReservations(engine)).toMatchObject({ shadowBytes: 0, shadowExemptBytes: 0 });
      endFrame(scene);
      controller.sync();
      expect(atlasTextureEdge(scene)).toBe(8192);
      expect(tileSizes(controller.generator(spot))).toEqual([2048]);
      expect(managedRenderReservations(engine)).toMatchObject({ shadowBytes: 256 * MIB, shadowExemptBytes: 0, limit: 1024 * MIB });
    });

    it.each([
      ["with a texture limit of 8192", 8192, null],
      ["on a phone", 16384, { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", maxTouchPoints: 5 }],
    ] as const)("falls back to 4096 maps %s and reports it", (_device, maxTextureSize, nav) => {
      if (nav) vi.stubGlobal("navigator", nav);
      const { scene, controller } = fixture();
      Object.assign(scene.getEngine().getCaps(), { maxTextureSize });
      updateSceneRenderingSettings(scene, { shadows: highAt8192() });
      const sun = new DirectionalLight("sun", Vector3.Down(), scene);
      controller.register(sun, true);
      controller.sync();
      expect(atlasTextureEdge(scene)).toBe(8192);
      expect(controller.limits()).toEqual(["shadow map reduced by shadow atlas space"]);
      expect(captureShadowDiagnostics(scene).lights[0]).toMatchObject({
        requestedMapSize: 8192, allocationDownsized: true, generator: { mapSize: 4096, tiles: [4096, 4096, 4096, 2048] },
      });
    });

    it("falls back to the level's atlas when the device cannot allocate the grown one", () => {
      const { scene, controller } = fixture();
      const engine = scene.getEngine();
      Object.assign(engine.getCaps(), { maxTextureSize: 16384 });
      updateSceneRenderingSettings(scene, { shadows: highAt8192() });
      const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, scene);
      const sun = new DirectionalLight("sun", Vector3.Down(), scene);
      // The spot light's tile, built first, makes the 16384 atlas, which the driver refuses once.
      controller.register(spot, true);
      controller.register(sun, true);
      vi.spyOn(engine, "createRenderTargetTexture").mockImplementationOnce(() => {
        throw new Error("out of memory");
      });
      controller.sync();
      // Nothing more is built in the refused atlas; the sun asks for half its map from the next sync.
      expect([controller.generator(spot), controller.generator(sun), shadowAtlasBytes(scene)]).toEqual([null, null, 0]);
      expect(controller.diagnostics([sun])[0]).toMatchObject({ status: "budget-limited", allocationError: "out of memory" });
      controller.sync();
      expect(atlasTextureEdge(scene)).toBe(8192);
      expect(tileSizes(controller.generator(sun))).toEqual([4096, 4096, 4096, 2048]);
      expect(tileSizes(controller.generator(spot))).toEqual([2048]);
      expect(controller.diagnostics([sun])[0]).toMatchObject({
        status: "active", mapSize: 4096, reason: "shadow map reduced after allocation failure",
      });
      expect(managedRenderReservations(engine)).toMatchObject({ shadowExemptBytes: 0 });
    });
  });
  it("registers late meshes and releases removed meshes and disabled light allocations", async () => {
    const { scene, controller } = fixture();
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(light, true);
    controller.sync();
    const added = new Promise<void>((resolve) =>
      scene.onNewMeshAddedObservable.addOnce(() => resolve()),
    );
    const mesh = MeshBuilder.CreateBox("spawned", {}, scene);
    await added;
    controller.sync();
    expect(controller.generator(light)?.getShadowMap()?.renderList).toContain(
      mesh,
    );
    expect(mesh.receiveShadows).toBe(true);
    controller.setParticipation(mesh, {
      castShadows: false,
      receiveShadows: true,
    });
    controller.sync();
    expect(
      controller.generator(light)?.getShadowMap()?.renderList,
    ).not.toContain(mesh);
    expect(mesh.receiveShadows).toBe(true);
    // Screen-Space Shadows march over the geometry pass's caster mark, which follows Cast Shadows too.
    expect(meshCastsShadows(mesh)).toBe(false);
    controller.setParticipation(mesh, {
      castShadows: true,
      receiveShadows: false,
    });
    controller.sync();
    expect(controller.generator(light)?.getShadowMap()?.renderList).toContain(
      mesh,
    );
    expect(mesh.receiveShadows).toBe(false);
    expect(meshCastsShadows(mesh)).toBe(true);
    mesh.dispose();
    expect(
      controller.generator(light)?.getShadowMap()?.renderList,
    ).not.toContain(mesh);
    light.setEnabled(false);
    controller.sync();
    expect(controller.generator(light)).toBeNull();
    light.setEnabled(true);
    controller.sync();
    expect(controller.generator(light)).not.toBeNull();
    controller.register(light, false);
    controller.sync();
    expect(controller.generator(light)).toBeNull();
  });
  it("registers meshes created in the same task as the frame, before Babylon's deferred notification", async () => {
    const { scene, controller } = fixture();
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(light, true);
    const replaced = MeshBuilder.CreateBox("replaced", {}, scene);
    controller.sync();
    // A replacement keeps scene.meshes the same length; both frames run synchronously.
    replaced.dispose();
    const mesh = MeshBuilder.CreateBox("spawned", {}, scene);
    controller.sync();
    const casters = () =>
      (controller.generator(light)?.getShadowMap()?.renderList ?? []).map((caster) => caster.name);
    expect(casters()).toEqual(["spawned"]);
    expect(mesh.receiveShadows).toBe(true);
    const sibling = MeshBuilder.CreateBox("sibling", {}, scene);
    controller.sync();
    expect(casters()).toEqual(["spawned", "sibling"]);
    // The late notification must not duplicate or reorder an existing caster.
    await new Promise<void>((resolve) =>
      scene.onNewMeshAddedObservable.add((added) => {
        if (added === sibling) resolve();
      }),
    );
    controller.sync();
    expect(casters()).toEqual(["spawned", "sibling"]);
  });
  it("lets a removal win over Babylon's deferred add, and registers a mesh that returns to the Scene", async () => {
    const { scene, controller } = fixture();
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(light, true);
    controller.sync();
    const casters = () => controller.generator(light)?.getShadowMap()?.renderList ?? [];
    const added = (target: ReturnType<typeof MeshBuilder.CreateBox>) =>
      new Promise<void>((resolve) =>
        scene.onNewMeshAddedObservable.add((mesh) => {
          if (mesh === target) resolve();
        }),
      );
    // Leaves the Scene (still alive) before the add notification arrives.
    const proxy = MeshBuilder.CreateBox("proxy", {}, scene);
    const proxyAdded = added(proxy);
    scene.removeMesh(proxy);
    await proxyAdded;
    controller.sync();
    expect(casters()).not.toContain(proxy);
    // Returning to the Scene registers it again.
    const returned = added(proxy);
    scene.addMesh(proxy);
    await returned;
    controller.sync();
    expect(casters()).toContain(proxy);
    scene.removeMesh(proxy);
    expect(casters()).not.toContain(proxy);
    const again = added(proxy);
    scene.addMesh(proxy);
    await again;
    controller.sync();
    expect(casters()).toContain(proxy);
  });
  it("does not queue a mesh that left the Scene before the controller existed when Babylon's deferred add arrives", async () => {
    // A mesh a Babylon helper creates and removes at once, before the controller exists.
    let proxy!: ReturnType<typeof MeshBuilder.CreateBox>;
    const { scene, controller } = fixture((bare) => {
      proxy = MeshBuilder.CreateBox("proxy", {}, bare);
      bare.removeMesh(proxy);
    });
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(light, true);
    const added = (target: ReturnType<typeof MeshBuilder.CreateBox>) =>
      new Promise<void>((resolve) =>
        scene.onNewMeshAddedObservable.add((mesh) => {
          if (mesh === target) resolve();
        }),
      );
    // A mesh the controller does hear about while the older notice is still pending.
    const receiver = MeshBuilder.CreateBox("receiver", {}, scene);
    await Promise.all([added(proxy), added(receiver)]);
    controller.sync();
    const casters = (controller.generator(light)?.getShadowMap()?.renderList ?? []).map(
      (caster) => caster.name,
    );
    expect(casters).toEqual(["receiver"]);
  });
  it("adapts Low to admitted tile dimensions and updates projection and allocation in the current draw", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    engine.getCaps().maxTextureSize = 256;
    // The Low tier with one 1024 cascade over 80 m.
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ ...qualityPresetPatch("low").shadows, preset: "custom", distance: 80, mapSize: 1024, cascades: 1 }),
    });
    const authored = structuredClone(sceneRenderingSettings(scene).shadows);
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    controller.register(light, true);
    controller.sync();
    const generator = controller.generator(light) as CascadedShadowGenerator;
    // The texture limit bounds the atlas, and its one tile with it.
    expect(tileSizes(generator)).toEqual([256]);
    expect(controller.diagnostics([light])[0]).toMatchObject({ mapSize: 256, effectiveFilter: "pcf" });
    prepareShadowLayers(generator);
    const near = cascadeTexel(generator, 0, 256);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(near, 7);
    expect(generator.bias).toBeGreaterThan(authored.depthBias);
    expect(generator.bias).toBeCloseTo(cascadeDepthBias(generator, 0, 256, authored.depthBias), 8);
    expect(generator.normalBias).toBe(0.005);
    expect(sceneRenderingSettings(scene).shadows.mapSize).toBe(1024);

    // A longer shadow distance refits the same tile over more of the world in the next draw.
    updateSceneRenderingSettings(scene, {
      shadows: { ...sceneRenderingSettings(scene).shadows, distance: 160 },
    });
    controller.sync();
    prepareShadowLayers(generator);
    expect(controller.generator(light)).toBe(generator);
    const far = cascadeTexel(generator, 0, 256);
    expect(far).toBeGreaterThan(near);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(far, 7);
    expect(generator.bias).toBeCloseTo(cascadeDepthBias(generator, 0, 256, authored.depthBias), 8);

    // A restored context with a larger texture limit rebuilds the map at its requested size, in an atlas of that
    // limit from the frame after the old one went.
    engine.getCaps().maxTextureSize = 4096;
    engine.onContextRestoredObservable.notifyObservers(engine);
    controller.sync();
    endFrame(scene);
    controller.sync();
    const recovered = controller.generator(light) as CascadedShadowGenerator;
    expect(recovered).not.toBe(generator);
    expect(tileSizes(recovered)).toEqual([1024]);
    prepareShadowLayers(recovered);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(cascadeTexel(recovered, 0, 1024), 7);
    expect(recovered.bias).toBeCloseTo(cascadeDepthBias(recovered, 0, 1024, authored.depthBias), 8);
  });

  it("reads the replacement camera projection before deriving directional bias", () => {
    const { scene, controller } = fixture();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 1, distance: 10, mapSize: 512 }),
    });
    const light = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    controller.register(light, true);
    controller.sync();
    const generator = controller.generator(light) as CascadedShadowGenerator;
    prepareShadowLayers(generator);
    const perspective = cascadeTexel(generator, 0, 512);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(perspective, 7);
    const replacement = new UniversalCamera("orthographic", new Vector3(4, 3, -8), scene);
    replacement.mode = 1;
    replacement.orthoLeft = -40;
    replacement.orthoRight = 40;
    replacement.orthoBottom = -20;
    replacement.orthoTop = 20;
    scene.activeCamera = replacement;
    controller.sync();
    prepareShadowLayers(generator);
    expect(controller.generator(light)).toBe(generator);
    // The cascade fits the replacement's 80-unit-wide view, not the perspective camera's.
    const orthographic = cascadeTexel(generator, 0, 512);
    expect(orthographic).not.toBeCloseTo(perspective, 3);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(orthographic, 7);
  });

  it("derives each cascade from its current extents and restores exact manual bias", () => {
    const { scene, controller } = fixture();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({
        cascades: 2, distance: 40, mapSize: 1024, filterQuality: "low",
        depthBias: 0, normalBias: 0.001,
      }),
    });
    const caster = MeshBuilder.CreateBox("caster", { size: 5 }, scene);
    controller.setParticipation(caster, { castShadows: true, receiveShadows: true });
    const light = new DirectionalLight("sun", new Vector3(0.4, -1, 0.6), scene);
    controller.register(light, true);
    controller.sync();
    const generator = controller.generator(light) as CascadedShadowGenerator;
    expect(generator).toBeInstanceOf(CascadedShadowGenerator);
    expect(generator.getShadowMap()!.is2DArray).toBe(true);
    expect(generator.getShadowMap()!.getRenderLayers()).toBe(2);
    prepareShadowLayers(generator);
    const effective = controller.effectiveBias(light).map((value) => ({ ...value }));
    expect(effective).toHaveLength(2);
    expect(effective[1].worldTexelSize).toBeGreaterThan(effective[0].worldTexelSize);
    for (let layer = 0; layer < 2; layer++) {
      const min = generator.getCascadeMinExtents(layer)!;
      const max = generator.getCascadeMaxExtents(layer)!;
      // Each cascade's own tile.
      const texel = Math.max(max.x - min.x, max.y - min.y) / tileSizes(generator)[layer]!;
      expect(effective[layer].worldTexelSize).toBeCloseTo(texel, 7);
      expect(effective[layer].depthBias).toBeCloseTo(Math.min(0.05, (texel / 4) / (max.z - min.z) / 1.5), 8);
      expect(effective[layer].normalBias).toBe(0.001);
    }
    scene.activeCamera!.position.x += 6;
    scene.activeCamera!.getViewMatrix(true);
    prepareShadowLayers(generator);
    expect(controller.effectiveBias(light)[0].worldTexelSize).toBeCloseTo(effective[0].worldTexelSize, 7);

    updateSceneRenderingSettings(scene, {
      shadows: {
        ...sceneRenderingSettings(scene).shadows,
        autoBias: false,
        depthBias: 0.002,
        normalBias: 0.025,
      },
    });
    controller.sync();
    prepareShadowLayers(generator);
    expect(generator.bias).toBe(0.002);
    expect(generator.normalBias).toBe(0.025);
    expect(controller.effectiveBias(light).map(({ mode, depthBias, normalBias }) => ({ mode, depthBias, normalBias })))
      .toEqual([{ mode: "manual", depthBias: 0.002, normalBias: 0.025 }, { mode: "manual", depthBias: 0.002, normalBias: 0.025 }]);
    expect(sceneRenderingSettings(scene).shadows).toMatchObject({ autoBias: false, depthBias: 0.002, normalBias: 0.025 });
  });
  it("invalidates an automatic bias mode change once and keeps the maps", () => {
    const { scene, controller } = fixture();
    scene.getEngine()._features.supportShadowSamplers = true;
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 1, scene);
    controller.register(sun, true);
    controller.register(spot, true);
    controller.sync();
    const directional = controller.generator(sun)!;
    const local = controller.generator(spot)!;
    const dirty = vi.spyOn(scene, "markAllMaterialsAsDirty");
    updateSceneRenderingSettings(scene, { shadows: { ...sceneRenderingSettings(scene).shadows, autoBias: false } });
    controller.sync();
    expect(dirty).toHaveBeenCalled();
    const count = dirty.mock.calls.length;
    controller.sync();
    expect(dirty).toHaveBeenCalledTimes(count);
    expect(controller.generator(sun)).toBe(directional);
    expect(controller.generator(spot)).toBe(local);
  });
  it("budgets local lights separately and transfers capacity when an owner is disabled", () => {
    const { scene, controller } = fixture();
    const a = new PointLight("a", Vector3.Zero(), scene);
    const b = new PointLight("b", Vector3.Zero(), scene);
    controller.register(a, true);
    controller.register(b, true);
    controller.sync();
    expect(controller.diagnostics().map((light) => light.status)).toEqual([
      "active",
      "budget-limited",
    ]);
    a.setEnabled(false);
    controller.sync();
    expect(controller.diagnostics().map((light) => light.status)).toEqual([
      "disabled",
      "active",
    ]);
    expect(controller.diagnostics()[1]?.passes).toBe(6);
  });
  it("keeps water out of shadow maps even when authored to cast, while it still receives shadows", () => {
    const { scene, controller } = fixture();
    const sun = new DirectionalLight("sun", new Vector3(0.3, -1, 0.2), scene);
    const lake = createWaterMesh(scene, "lake", normalizeWaterBody({ width: 10, length: 10, resolution: 8 }), undefined, builtInWaterMaterial(scene));
    const rock = MeshBuilder.CreateBox("rock", {}, scene);
    for (const mesh of [lake, rock]) controller.setParticipation(mesh, { castShadows: true, receiveShadows: true });
    controller.register(sun, true);
    controller.sync();
    const casters = controller.generator(sun)!.getShadowMap()!.renderList!;
    expect(casters).toContain(rock);
    expect(casters).not.toContain(lake);
    expect(lake.receiveShadows).toBe(true);
  });
  it("keeps helper meshes out of shadow maps and responds to camera replacement", () => {
    const { scene, controller } = fixture();
    const light = new DirectionalLight("sun", new Vector3(0, -1, 1), scene);
    const helper = MeshBuilder.CreateBox("__helper", {}, scene);
    controller.register(light, true);
    controller.sync();
    expect(
      controller.generator(light)?.getShadowMap()?.renderList,
    ).not.toContain(helper);
    const previous = controller.generator(light);
    scene.activeCamera = new UniversalCamera(
      "possessed",
      Vector3.Zero(),
      scene,
    );
    controller.sync();
    expect(controller.generator(light)).toBe(previous);
    const map = previous?.getShadowMap();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({
        cascades: 1,
        distance: 100,
        autoBias: false,
        normalBias: 0.025,
        depthBias: 0.002,
        filter: "pcss",
      }),
    });
    controller.sync();
    expect(controller.generator(light)).toBe(previous);
    expect(controller.generator(light)?.getShadowMap()).toBe(map);
    expect(controller.generator(light)?.normalBias).toBe(0.025);
    expect(controller.generator(light)?.bias).toBe(0.002);
  });
  it("selects nearest shadows independently of intensity and honors explicit priority immediately", () => {
    const { scene, controller } = fixture();
    const a = new PointLight("a", Vector3.Zero(), scene);
    const b = new PointLight("b", new Vector3(20, 0, 0), scene);
    controller.register(a, true);
    controller.register(b, true);
    controller.sync();
    b.intensity = 1.05;
    controller.sync();
    expect(controller.generator(a)).not.toBeNull();
    b.intensity = 100;
    controller.sync();
    expect(controller.generator(a)).not.toBeNull();
    expect(controller.generator(b)).toBeNull();
    controller.register(b, true, 1);
    controller.sync();
    expect(controller.generator(a)).toBeNull();
    expect(controller.generator(b)).not.toBeNull();
  });
  it("follows a replacement active camera and preserves deterministic distance hysteresis", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
    const { scene, controller } = fixture();
    const a = new PointLight("near-start", new Vector3(0, 0, 0), scene);
    const b = new PointLight("near-destination", new Vector3(100, 0, 0), scene);
    controller.register(a, true);
    controller.register(b, true);
    controller.sync();
    expect(controller.generator(a)).not.toBeNull();
    scene.activeCamera = new UniversalCamera(
      "possessed",
      new Vector3(100, 0, -5),
      scene,
    );
    controller.sync();
    expect(controller.generator(a)).toBeNull();
    const incumbent = controller.generator(b);
    expect(incumbent).not.toBeNull();
    scene.activeCamera.position.x = 50;
    clock.mockReturnValue(100);
    controller.sync();
    expect(controller.generator(b)).toBe(incumbent);
    scene.activeCamera.position.x = 0;
    controller.sync();
    expect(controller.generator(b)).toBe(incumbent);
    clock.mockReturnValue(300);
    controller.sync();
    expect(controller.generator(a)).not.toBeNull();
    } finally { clock.mockRestore(); }
  });

  it("keeps newly selected maps resident across motion but releases ineligible owners immediately", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const { scene, controller } = fixture();
      const a = new PointLight("start", Vector3.Zero(), scene);
      const b = new PointLight("destination", new Vector3(100, 0, 0), scene);
      controller.register(a, true);
      controller.register(b, true);
      controller.sync();
      const original = controller.generator(a);
      expect(original).not.toBeNull();
      scene.activeCamera!.position.x = 100;
      clock.mockReturnValue(100);
      controller.sync();
      expect(controller.generator(a)).toBe(original);
      clock.mockReturnValue(300);
      controller.sync();
      const promoted = controller.generator(b);
      expect(promoted).not.toBeNull();
      expect(controller.generator(a)).toBeNull();
      scene.activeCamera!.position.x = 0;
      clock.mockReturnValue(350);
      controller.sync();
      expect(controller.generator(b)).toBe(promoted);
      b.intensity = 0;
      controller.sync();
      expect(controller.generator(b)).toBeNull();
      expect(controller.generator(a)).not.toBeNull();
    } finally { clock.mockRestore(); }
  });

  it(
    "keeps the retained sun's caster bounds and limits current across a local handoff",
    () => {
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      try {
        const { scene, controller } = fixture();
        // The sun's requested map exceeds the device size, so admission reduces it.
        scene.getEngine().getCaps().maxTextureSize = 1024;
        updateSceneRenderingSettings(scene, {
          shadows: normalizeShadowSettings({ cascades: 2, mapSize: 2048, localMapSize: 256, maxLocalLights: 1 }),
        });
        const caster = MeshBuilder.CreateBox("caster", {}, scene);
        caster.material = new StandardMaterial("receiver", scene);
        controller.setParticipation(caster, { castShadows: true, receiveShadows: true });
        const sun = new DirectionalLight("sun", new Vector3(0.4, -1, 0.6), scene);
        const near = new SpotLight("near", new Vector3(0, 3, -2), Vector3.Down(), Math.PI / 2, 1, scene);
        const far = new SpotLight("far", new Vector3(40, 3, -2), Vector3.Down(), Math.PI / 2, 1, scene);
        near.range = far.range = 100;
        for (const light of [sun, near, far]) controller.register(light, true);
        controller.sync();
        const generator = controller.generator(sun)!;
        const local = controller.generator(near)!;
        expect(generator).toBeInstanceOf(AtlasCascadedShadowGenerator);
        const sunReason = controller.diagnostics([sun])[0]!.reason;
        expect(sunReason).toContain("shadow map reduced");
        scene.activeCamera!.position.x = 40;
        caster.position.x = 60;
        caster.computeWorldMatrix(true);
        clock.mockReturnValue(500);
        controller.sync();
        // The local map moves in the same sync; the retained sun keeps its own limits.
        expect(controller.generator(far)).toBe(local);
        expect(controller.generator(near)).toBeNull();
        expect(controller.generator(sun)).toBe(generator);
        expect(controller.diagnostics([sun, far]).map(({ status, reason }) => ({ status, reason })))
          .toEqual([{ status: "active", reason: sunReason }, { status: "active", reason: null }]);
        expect((generator as CascadedShadowGenerator).shadowCastersBoundingInfo.maximum.x).toBeGreaterThan(60);
      } finally { clock.mockRestore(); }
    },
  );

  it("refreshes parented and detached light positions before shadow selection", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const { scene, controller } = fixture();
      scene.activeCamera!.position.set(0, 0, 0);
      const parent = new TransformNode("parent", scene);
      parent.position.x = -200;
      const a = new PointLight("parented", new Vector3(100, 0, 0), scene);
      a.parent = parent;
      const b = new PointLight("other", new Vector3(50, 0, 0), scene);
      controller.register(a, true);
      controller.register(b, true);
      controller.sync();
      expect(controller.generator(a)).toBeNull();
      expect(controller.generator(b)).not.toBeNull();
      parent.position.x = -90;
      clock.mockReturnValue(300);
      controller.sync();
      expect(controller.generator(a)).not.toBeNull();
      expect(controller.generator(b)).toBeNull();
      a.parent = null;
      clock.mockReturnValue(600);
      controller.sync();
      expect(controller.generator(a)).toBeNull();
      expect(controller.generator(b)).not.toBeNull();
    } finally { clock.mockRestore(); }
  });

  it("promotes a nearer sub-unit light after residency expires", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const { scene, controller } = fixture();
      scene.activeCamera!.position.set(0, 0, 0);
      const a = new PointLight("incumbent", new Vector3(0.9, 0, 0), scene);
      const b = new PointLight("nearer", new Vector3(0.1, 0, 0), scene);
      controller.register(a, true);
      controller.sync();
      const initial = controller.generator(a);
      controller.register(b, true);
      clock.mockReturnValue(100);
      controller.sync();
      expect(controller.generator(a)).toBe(initial);
      clock.mockReturnValue(300);
      controller.sync();
      expect(controller.generator(a)).toBeNull();
      expect(controller.generator(b)).not.toBeNull();
    } finally { clock.mockRestore(); }
  });
  it("moves a local map to a nearer same-kind light without allocation or receiver changes", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
      const { scene, controller } = fixture();
      scene.activeCamera!.position.set(0, 0, 0);
      const receiver = MeshBuilder.CreateBox("receiver", {}, scene);
      receiver.material = new StandardMaterial("receiver", scene);
      controller.setParticipation(receiver, { castShadows: true, receiveShadows: true });
      const near = new PointLight("near", new Vector3(5, 0, 0), scene);
      const far = new PointLight("far", new Vector3(50, 0, 0), scene);
      controller.register(near, true);
      controller.register(far, true);
      controller.sync();
      const generator = controller.generator(near)!;
      const part = receiver.subMeshes[0]!;
      receiver.material.isReadyForSubMesh(receiver, part);
      const defines = part.materialDefines!.toString();
      expect(defines).toContain("SHADOW0");
      // A new map would place atlas tiles.
      const allocate = vi.spyOn(ShadowAtlasAllocator.prototype, "allocate");
      const dispose = vi.spyOn(generator, "dispose");
      const dirty = vi.spyOn(receiver, "_markSubMeshesAsLightDirty");
      scene.activeCamera!.position.x = 50;
      clock.mockReturnValue(300);
      controller.sync();
      expect(controller.generator(far)).toBe(generator);
      expect(controller.generator(near)).toBeNull();
      expect(near.getShadowGenerator()).toBeNull();
      expect(allocate).not.toHaveBeenCalled();
      expect(dispose).not.toHaveBeenCalled();
      expect(dirty).not.toHaveBeenCalled();
      // Re-preparing proves the exchanged shader light indices keep every define.
      receiver._markSubMeshesAsLightDirty();
      receiver.material.isReadyForSubMesh(receiver, part);
      expect(part.materialDefines!.toString()).toBe(defines);
      // The moved map samples neutrally until it has redrawn for its new light.
      expect(generator.getDarkness()).toBe(1);
      prepareShadowLayers(generator);
      expect(generator.getDarkness()).toBe(0);
    } finally { clock.mockRestore(); }
  });

  it("keeps a camera-rejected local map on standby, unrendered, for the next same-kind light", async () => {
    const { scene, controller } = fixture();
    scene.activeCamera!.position.set(0, 0, 0);
    const receiver = MeshBuilder.CreateBox("receiver", {}, scene);
    receiver.material = new StandardMaterial("receiver", scene);
    controller.setParticipation(receiver, { castShadows: true, receiveShadows: true });
    // An observed caster cannot be cached, so admitted local maps redraw every frame.
    receiver.onBeforeRenderObservable.add(() => {});
    const first = new PointLight("first", new Vector3(5, 0, 0), scene);
    first.range = 10;
    controller.register(first, true);
    controller.sync();
    const generator = controller.generator(first)!;
    // Babylon retries a map every frame until its caster shaders are ready.
    await generator.forceCompilationAsync();
    const map = generator.getShadowMap()!;
    const bytes = controller.metrics().bytes;
    const dispose = vi.spyOn(generator, "dispose");
    const dirty = vi.spyOn(receiver, "_markSubMeshesAsLightDirty");
    scene.activeCamera!.position.x = 1000;
    controller.sync();
    expect(controller.diagnostics([first])[0]!.status).toBe("outside-relevant-area");
    expect(controller.generator(first)).toBeNull();
    // Receivers keep the attached map, and so their defines, at neutral darkness.
    expect(first.getShadowGenerator()).toBe(generator);
    expect(generator.getDarkness()).toBe(1);
    expect(dirty).not.toHaveBeenCalled();
    expect(controller.metrics()).toEqual({ passes: 0, bytes });
    // Only actual passes clear; one final pass may follow the refresh-rate change.
    let clears = 0;
    map.onClearObservable.add(() => clears++);
    for (let frame = 0; frame < 3; frame++) scene.render();
    expect(clears).toBeLessThanOrEqual(6);
    // A new map would place atlas tiles.
    const allocate = vi.spyOn(ShadowAtlasAllocator.prototype, "allocate");
    const next = new PointLight("next", new Vector3(1005, 0, 0), scene);
    next.range = 10;
    controller.register(next, true);
    controller.sync();
    expect(controller.generator(next)).toBe(generator);
    expect(first.getShadowGenerator()).toBeNull();
    expect(allocate).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  /** A shadowed point light the one-slot Forward budget has dropped for a nearer unshadowed one. */
  function forwardDroppedStandby() {
    const { scene, controller } = fixture();
    scene.activeCamera!.position.set(0, 0, 0);
    const receiver = MeshBuilder.CreateBox("receiver", {}, scene);
    receiver.material = new StandardMaterial("receiver", scene);
    controller.setParticipation(receiver, { castShadows: true, receiveShadows: true });
    const shadowed = new PointLight("shadowed", new Vector3(5, 0, 0), scene);
    const nearer = new PointLight("nearer", new Vector3(1, 0, 0), scene);
    controller.register(shadowed, true);
    syncForwardLightPolicy(scene, 2, selectHapticLights);
    controller.sync();
    const generator = controller.generator(shadowed)!;
    const dispose = vi.spyOn(generator, "dispose");
    syncForwardLightPolicy(scene, 1, selectHapticLights);
    controller.sync();
    expect(shadowed.isEnabled()).toBe(false);
    expect(nearer.isEnabled()).toBe(true);
    return { scene, controller, shadowed, nearer, generator, dispose };
  }

  it("keeps the map of a light the Forward budget dropped on standby until the light returns", () => {
    const { scene, controller, shadowed, generator, dispose } = forwardDroppedStandby();
    // A new map would place atlas tiles.
    const allocate = vi.spyOn(ShadowAtlasAllocator.prototype, "allocate");
    expect(controller.generator(shadowed)).toBeNull();
    expect(shadowed.getShadowGenerator()).toBe(generator);
    expect(generator.getDarkness()).toBe(1);
    expect(controller.metrics().passes).toBe(0);
    expect(controller.metrics().bytes).toBeGreaterThan(0);
    expect(dispose).not.toHaveBeenCalled();
    // Capacity returns: the same map is admitted again, neutral until redrawn.
    syncForwardLightPolicy(scene, 2, selectHapticLights);
    controller.sync();
    expect(controller.generator(shadowed)).toBe(generator);
    expect(controller.diagnostics([shadowed])[0]!.status).toBe("active");
    expect(generator.getDarkness()).toBe(1);
    prepareShadowLayers(generator);
    expect(generator.getDarkness()).toBe(0);
    expect(allocate).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("keeps the standby map of a Forward-dropped light through a change of the shadow level's label alone", () => {
    const { scene, controller, shadowed, generator, dispose } = forwardDroppedStandby();
    const before = sceneRenderingSettings(scene).shadows;
    // The level's values labelled Custom: what a session step that changes no value leaves (and its reset undoes).
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ ...before, preset: "custom" }) });
    expect(sceneRenderingSettings(scene).shadows).toEqual({ ...before, preset: "custom" });
    controller.sync();
    expect(shadowed.getShadowGenerator()).toBe(generator);
    expect(dispose).not.toHaveBeenCalled();
  });

  it("serialises the shadow settings once per change, not at each sync that compares them with a standby map's or the caster variants' maps", async () => {
    // The break: every sync deriving new effective settings, which the standby map's retention and the caster
    // variants' maps then compare by serialising both (`qualityValuesKey`, a JSON.stringify), at each of a Play frame's
    // syncs.
    const { scene, controller, shadowed, generator, dispose } = forwardDroppedStandby();
    controller.warmCasterVariants();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.sync();
    const stringify = vi.spyOn(JSON, "stringify");
    for (let frame = 0; frame < 3; frame++) {
      controller.sync("admission");
      controller.sync();
    }
    expect(stringify).not.toHaveBeenCalled();
    // New settings of the same values (a label change) are serialised once, and keep the maps.
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ ...sceneRenderingSettings(scene).shadows, preset: "custom" }) });
    stringify.mockClear();
    controller.sync();
    controller.sync("admission");
    expect(stringify).toHaveBeenCalledOnce();
    expect([controller.generator(shadowed), shadowed.getShadowGenerator()]).toEqual([null, generator]);
    expect(dispose).not.toHaveBeenCalled();
  });

  it.each([
    ["a withdrawn shadow request", ({ controller, shadowed }: ReturnType<typeof forwardDroppedStandby>) =>
      controller.register(shadowed, false)],
    ["shadows turned off", ({ scene }: ReturnType<typeof forwardDroppedStandby>) =>
      updateSceneRenderingSettings(scene, {
        shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1, enabled: false }),
      })],
  ])("releases the standby map of a Forward-dropped light on %s", (_name, change) => {
    const context = forwardDroppedStandby();
    const { controller, shadowed, dispose } = context;
    // The light stays disabled, which hides the change from its status.
    expect(shadowed.getShadowGenerator()).not.toBeNull();
    change(context);
    controller.sync();
    expect(controller.generator(shadowed)).toBeNull();
    expect(shadowed.getShadowGenerator()).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
    expect(controller.metrics()).toEqual({ passes: 0, bytes: 0 });
  });

  it("ranks a standby map handed to a new winner by its light's current distance, not the distance it had when dropped", () => {
    const { scene, controller } = fixture();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 2 }),
    });
    const camera = scene.activeCamera!;
    camera.position.set(0, 0, 0);
    const near = new PointLight("near", new Vector3(1, 0, 0), scene);
    const dropped = new PointLight("dropped", new Vector3(6, 0, 0), scene);
    const rejected = new PointLight("rejected", new Vector3(5, 0, 0), scene);
    for (const light of [dropped, rejected]) {
      light.range = 10;
      controller.register(light, true);
    }
    controller.sync();
    const droppedMap = controller.generator(dropped)!;
    const rejectedMap = controller.generator(rejected)!;
    // The camera leaves: only `dropped` loses its Forward slot, and `rejected`
    // leaves the relevant area. Both keep their maps, but `dropped` is now the
    // farther one, though it was the nearest light with a stale measurement.
    camera.position.set(-1000, 0, 0);
    const winner = new PointLight("winner", new Vector3(-1001, 0, 0), scene);
    winner.range = 10;
    controller.register(winner, true);
    syncForwardLightPolicy(scene, 3, selectHapticLights);
    controller.sync();
    expect(isForwardLightExcluded(dropped)).toBe(true);
    expect(controller.diagnostics([rejected])[0]!.status).toBe("outside-relevant-area");
    expect(near.isEnabled()).toBe(true);
    // The new winner takes the farthest retained map and the nearer one waits.
    expect(controller.generator(winner)).toBe(droppedMap);
    expect(rejected.getShadowGenerator()).toBe(rejectedMap);
  });

  it("frees standby maps before reducing an admitted map that finds no room in the atlas", () => {
    const { scene, controller } = fixture();
    // A 2048 atlas: a point light's six 512 tiles take two of its four 1024 quadrants.
    scene.getEngine().getCaps().maxTextureSize = 2048;
    // Low keeps every cascade's tile at the map size.
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ profile: "low", cascades: 3, mapSize: 1024, maxLocalLights: 1, localMapSize: 512 }),
    });
    scene.activeCamera!.position.set(0, 0, 0);
    const point = new PointLight("point", new Vector3(5, 0, 0), scene);
    point.range = 10;
    controller.register(point, true);
    controller.sync();
    const standby = controller.generator(point)!;
    expect(tileSizes(standby)).toEqual(Array(6).fill(512));
    scene.activeCamera!.position.x = 1000;
    controller.sync();
    expect(controller.generator(point)).toBeNull();
    expect(point.getShadowGenerator()).toBe(standby);
    // The sun's three 1024 cascades fit the atlas's area, but only two fit beside the standby tiles.
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    controller.register(sun, true);
    const placement = vi.spyOn(ShadowAtlasAllocator.prototype, "allocate");
    controller.sync();
    // The first placement found no third quadrant; the retry, with the standby tiles freed, did.
    expect(placement.mock.results.filter(({ value }) => value === null)).toHaveLength(1);
    placement.mockRestore();
    expect(controller.diagnostics([sun])[0]!.status).toBe("active");
    expect(tileSizes(controller.generator(sun))).toEqual([1024, 1024, 1024]);
    expect(controller.diagnostics([sun])[0]!.reason).toBeNull();
    expect(point.getShadowGenerator()).toBeNull();
    expect(standby.getShadowMap()).toBeNull();
  });

  it("releases a standby map when its light no longer requests shadows", () => {
    const { scene, controller } = fixture();
    scene.activeCamera!.position.set(0, 0, 0);
    const light = new PointLight("light", new Vector3(5, 0, 0), scene);
    light.range = 10;
    controller.register(light, true);
    controller.sync();
    const map = controller.generator(light)!.getShadowMap()!;
    scene.activeCamera!.position.x = 1000;
    controller.sync();
    expect(light.getShadowGenerator()).not.toBeNull();
    controller.register(light, false);
    controller.sync();
    expect(light.getShadowGenerator()).toBeNull();
    expect(scene.textures).not.toContain(map);
    expect(controller.metrics()).toEqual({ passes: 0, bytes: 0 });
  });
  it("admits point lights' six face tiles by atlas area before construction, then lowers cost after a Low preset", () => {
    const { scene, controller } = fixture();
    // A desktop texture limit: Ultra's 8192 atlas.
    Object.assign(scene.getEngine().getCaps(), { maxTextureSize: 16384 });
    const placement = vi.spyOn(ShadowAtlasAllocator.prototype, "allocate");
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({
        profile: "ultra",
        maxLocalLights: 16,
        localMapSize: 2048,
      }),
    });
    const points = Array.from(
      { length: 16 },
      (_, i) => new PointLight(`point-${i}`, Vector3.Zero(), scene),
    );
    points.forEach((light) => controller.register(light, true));
    controller.sync();
    // Ultra's 52 passes hold eight lights' six faces; each halves its tiles until they fit the area the earlier
    // lights leave in the atlas.
    const active = points.filter((light) => controller.generator(light));
    expect(active).toHaveLength(8);
    expect(active.map((light) => tileSizes(controller.generator(light))[0])).toEqual([2048, 2048, 1024, 1024, 512, 512, 256, 256]);
    // Every tile was placed at its first try: admission sized it before construction.
    expect(placement.mock.results.map(({ value }) => value !== null)).toEqual(Array(48).fill(true));
    expect(controller.metrics()).toEqual({ passes: 48, bytes: 8192 ** 2 * 4 });
    expect(controller.metrics().bytes).toBeLessThanOrEqual(SHADOW_CAPACITY_PROFILES.ultra.byteBudget);
    controller.sync();
    expect(placement).toHaveBeenCalledTimes(48);
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ profile: "low", maxLocalLights: 16 }),
    });
    controller.sync();
    endFrame(scene);
    controller.sync();
    // Low's eight passes hold one light's six faces, in its 4096 atlas, made in the frame after Ultra's went.
    expect(points.filter((light) => controller.generator(light))).toHaveLength(
      1,
    );
    expect(controller.metrics()).toEqual({ passes: 6, bytes: 4096 ** 2 * 4 });
  });
  it("charges spot shadows by one face each and no material sampler", () => {
    const { scene, controller } = fixture();
    const caps = scene.getEngine().getCaps();
    caps.maxTexturesImageUnits = 32;
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({
        profile: "ultra",
        maxLocalLights: 16,
        localMapSize: 256,
      }),
    });
    const lights = Array.from(
      { length: 16 },
      (_, i) =>
        new SpotLight(
          `spot-${i}`,
          Vector3.Zero(),
          Vector3.Forward(),
          Math.PI / 2,
          1,
          scene,
        ),
    );
    lights.forEach((light) => controller.register(light, true));
    controller.sync();
    expect(controller.metrics().passes).toBe(16);
    // The light block samples every tile through the atlas, always bound: fewer texture units admit as many.
    caps.maxTexturesImageUnits = 11;
    controller.sync();
    expect(controller.metrics().passes).toBe(16);
    expect(controller.diagnostics().filter((light) => light.reason !== null)).toEqual([]);
  });
  it("shares the Engine allowance with previews and releases reservations on scene disposal", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    // A desktop texture limit: each Scene's Ultra atlas is 8192, whose area holds eight point lights' faces.
    Object.assign(engine.getCaps(), { maxTextureSize: 16384 });
    const preview = new Scene(engine);
    preview.activeCamera = new UniversalCamera(
      "preview-camera",
      Vector3.Zero(),
      preview,
    );
    const previewController = sceneShadowController(preview);
    for (const [client, owner] of [
      [scene, controller],
      [preview, previewController],
    ] as const) {
      updateSceneRenderingSettings(client, {
        shadows: normalizeShadowSettings({
          profile: "ultra",
          maxLocalLights: 16,
          localMapSize: 2048,
        }),
      });
      for (let i = 0; i < 16; i++)
        owner.register(
          new PointLight(`point-${i}`, Vector3.Zero(), client),
          true,
        );
      owner.sync();
    }
    expect(
      controller.metrics().passes + previewController.metrics().passes,
    ).toBeLessThanOrEqual(64);
    expect(
      controller.metrics().bytes + previewController.metrics().bytes,
    ).toBeLessThanOrEqual(ENGINE_SHADOW_BUDGET.bytes);
    // The Engine's 64 passes leave the preview two lights' faces beside the scene's 48.
    expect(controller.metrics().passes).toBe(48);
    expect(previewController.metrics().passes).toBe(12);
    scene.dispose();
    previewController.sync();
    expect(previewController.metrics().passes).toBe(48);
  });
  it("exhausts bounded smaller maps, admits healthy lights and retries after context recovery", async () => {
    const { scene, controller } = fixture();
    const light = new PointLight("point", Vector3.Zero(), scene);
    controller.register(light, true, 1);
    const fallback = new PointLight("fallback", Vector3.Zero(), scene);
    controller.register(fallback, true);
    const engine = scene.getEngine();
    const baselineTextures = [...scene.textures];
    const baselineInternals = [...engine.getLoadedTexturesCache()];
    const baselineWrappers = [...engine._renderTargetWrapperCache];
    const baselineResizeObservers = engine.onResizeObservable.observers.length;
    const baselineRenderPasses = engine.getRenderPassNames().filter(Boolean);
    // The first tile makes the atlas, so each attempt makes it again.
    const allocation = vi.spyOn(engine, "createRenderTargetTexture");
    for (let attempt = 0; attempt < 3; attempt++)
      allocation.mockImplementationOnce((...args) => {
        // A driver rejection after upload leaves the registered wrapper orphaned.
        NullEngine.prototype.createRenderTargetTexture.apply(engine, args);
        throw new Error("allocation failed");
      });
    controller.sync();
    expect(controller.metrics()).toEqual({ bytes: 0, passes: 0 });
    // One attempt at each size from 1024 to the 256 floor.
    expect(allocation).toHaveBeenCalledTimes(3);
    expect(scene.textures).toEqual(baselineTextures);
    expect(engine.getLoadedTexturesCache()).toEqual(baselineInternals);
    expect(engine._renderTargetWrapperCache).toEqual(baselineWrappers);
    expect(engine.getRenderPassNames().filter(Boolean)).toEqual(
      baselineRenderPasses,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.onResizeObservable.observers).toHaveLength(
      baselineResizeObservers,
    );
    controller.sync();
    controller.sync();
    expect(controller.generator(light)).toBeNull();
    expect(controller.diagnostics([light])[0]!.status).toBe("allocation-failed");
    expect(allocation).toHaveBeenCalledTimes(4);
    expect(controller.generator(fallback)).not.toBeNull();
    engine.onContextRestoredObservable.notifyObservers(engine);
    controller.sync();
    expect(controller.generator(light)).not.toBeNull();
    expect(tileSizes(controller.generator(light))[0]).toBe(1024);
    expect(controller.generator(fallback)).toBeNull();
  });
  it("releases a partially allocated atlas before retrying smaller without changing authored settings", async () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    const preview = new RenderTargetTexture("existing-preview", 256, scene);
    const previewTarget = preview.renderTarget;
    const baselineTextures = [...scene.textures];
    const baselineInternals = [...engine.getLoadedTexturesCache()];
    const baselineWrappers = [...engine._renderTargetWrapperCache];
    const baselineResizeObservers = engine.onResizeObservable.observers.length;
    const authored = structuredClone(sceneRenderingSettings(scene).shadows);
    const light = new PointLight("point", Vector3.Zero(), scene);
    controller.register(light, true);
    // The first tile makes the atlas: the driver rejects it once it is complete.
    const allocate = engine.createRenderTargetTexture.bind(engine);
    let orphanDispose: ReturnType<typeof vi.spyOn> | undefined;
    const allocation = vi
      .spyOn(engine, "createRenderTargetTexture")
      .mockImplementationOnce((...args) => {
        const orphan = allocate(...args);
        orphanDispose = vi.spyOn(orphan, "dispose");
        throw new Error("driver rejected completed atlas");
      });
    controller.sync();
    const retained = controller.generator(light);
    expect(tileSizes(retained)).toEqual(Array(6).fill(512));
    expect(controller.metrics()).toEqual({ bytes: shadowAtlasBytes(scene), passes: 6 });
    expect(shadowAtlasBytes(scene)).toBe(4096 ** 2 * 4);
    expect(sceneRenderingSettings(scene).shadows).toEqual(authored);
    expect(
      controller.diagnostics().find((entry) => entry.name === "point"),
    ).toMatchObject({
      status: "active",
      reason: "shadow map reduced after allocation failure",
      allocationError: "driver rejected completed atlas",
    });
    // The atlas was made again for the 512 tiles.
    expect(allocation).toHaveBeenCalledTimes(2);
    expect(orphanDispose).toHaveBeenCalledTimes(1);
    controller.sync();
    expect(controller.generator(light)).toBe(retained);
    expect(allocation).toHaveBeenCalledTimes(2);
    light.setEnabled(false);
    controller.sync();
    expect(scene.textures).toEqual(baselineTextures);
    expect(engine.getLoadedTexturesCache()).toEqual(baselineInternals);
    expect(engine._renderTargetWrapperCache).toEqual(baselineWrappers);
    expect(preview.renderTarget).toBe(previewTarget);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.onResizeObservable.observers).toHaveLength(
      baselineResizeObservers,
    );
    light.setEnabled(true);
    controller.sync();
    expect(tileSizes(controller.generator(light))[0]).toBe(512);
    engine.onContextRestoredObservable.notifyObservers(engine);
    controller.sync();
    expect(tileSizes(controller.generator(light))[0]).toBe(1024);
    const restoreObservers =
      engine.onContextRestoredObservable.observers.length;
    scene.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.onContextRestoredObservable.observers).toHaveLength(
      restoreObservers - 1,
    );
  });
  it("lifts a failed allocation's reduced size when the map size setting changes", () => {
    const { scene, controller } = fixture();
    const light = new PointLight("point", Vector3.Zero(), scene);
    controller.register(light, true);
    // The first tile makes the atlas, which the driver rejects once.
    vi.spyOn(scene.getEngine(), "createRenderTargetTexture")
      .mockImplementationOnce(() => {
        throw new Error("driver allocation failed");
      });
    controller.sync();
    expect(controller.diagnostics([light])[0]).toMatchObject({
      status: "active",
      reason: "shadow map reduced after allocation failure",
      allocationError: "driver allocation failed",
      mapSize: 512,
    });
    // The failure was keyed to the 1024 request; a 2048 request is new and
    // no longer limited by it. The atlas's area alone halves its six faces.
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1, localMapSize: 2048 }),
    });
    controller.sync();
    expect(controller.diagnostics([light])[0]).toMatchObject({
      status: "active",
      reason: "shadow map reduced by shadow atlas space",
      allocationError: null,
      mapSize: 1024,
    });
  });
  it("releases a non-throwing WebGL allocation failure and retains the validated smaller tiles", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    const authored = structuredClone(sceneRenderingSettings(scene).shadows);
    const light = new PointLight("point", Vector3.Zero(), scene);
    controller.register(light, true);
    const errors: number[] = [];
    const framebuffers = new Set<unknown>();
    const textures = new Set<unknown>();
    const renderbuffers = new Set<unknown>();
    const previousFramebuffer = {};
    let framebuffer: unknown = previousFramebuffer;
    const gl = {
      NO_ERROR: 0,
      OUT_OF_MEMORY: 0x0505,
      CONTEXT_LOST_WEBGL: 0x9242,
      FRAMEBUFFER: 0x8d40,
      FRAMEBUFFER_BINDING: 0x8ca6,
      FRAMEBUFFER_COMPLETE: 0x8cd5,
      COLOR_ATTACHMENT0: 0x8ce0,
      DEPTH_ATTACHMENT: 0x8d00,
      DEPTH_STENCIL_ATTACHMENT: 0x821a,
      RENDERBUFFER: 0x8d41,
      TEXTURE_2D: 0x0de1,
      TEXTURE_CUBE_MAP_POSITIVE_X: 0x8515,
      getError: vi.fn(() => errors.shift() ?? 0),
      isContextLost: () => false,
      isTexture: (resource: unknown) => textures.has(resource),
      isFramebuffer: (resource: unknown) => framebuffers.has(resource),
      isRenderbuffer: (resource: unknown) => renderbuffers.has(resource),
      getParameter: () => framebuffer,
      createFramebuffer: () => ({}),
      deleteFramebuffer: vi.fn(),
      bindFramebuffer: (_target: number, resource: unknown) => {
        framebuffer = resource;
      },
      framebufferTexture2D: vi.fn(),
      framebufferTextureLayer: vi.fn(),
      framebufferRenderbuffer: vi.fn(),
      checkFramebufferStatus: () => 0x8cd5,
    };
    const engineGl = Object.getOwnPropertyDescriptor(engine, "_gl");
    Object.defineProperty(engine, "_gl", { configurable: true, value: gl });
    // The first tile makes the atlas: a framebuffer whose only attachment is its depth texture.
    const allocate = engine.createRenderTargetTexture.bind(engine);
    let rejectedDispose: ReturnType<typeof vi.spyOn> | undefined;
    const allocation = vi
      .spyOn(engine, "createRenderTargetTexture")
      .mockImplementation((size, options) => {
        const target = allocate(size, options);
        // As WebGL makes it: NullEngine adds a colour texture even without a colour attachment.
        if (typeof options === "object" && options.noColorAttachment) target.releaseTextures();
        const targetFramebuffer = {};
        Object.assign(target, { _framebuffer: targetFramebuffer });
        framebuffers.add(targetFramebuffer);
        if (!rejectedDispose) {
          rejectedDispose = vi.spyOn(target, "dispose");
          // Babylon still returns a ready target when the driver reports OOM
          // through its error flag instead of throwing from texImage2D.
          errors.push(gl.OUT_OF_MEMORY);
        }
        return target;
      });
    const allocateDepth = engine.createDepthStencilTexture.bind(engine);
    vi.spyOn(engine, "createDepthStencilTexture").mockImplementation((...args) => {
      const texture = allocateDepth(...args);
      const resource = {};
      textures.add(resource);
      texture._hardwareTexture = { underlyingResource: resource } as InternalTexture["_hardwareTexture"];
      return texture;
    });
    try {
      controller.sync();
      const retained = controller.generator(light);
      expect(tileSizes(retained)).toEqual(Array(6).fill(512));
      // The atlas was made again for the 512 tiles.
      expect(allocation).toHaveBeenCalledTimes(2);
      expect(rejectedDispose).toHaveBeenCalledTimes(1);
      expect(controller.diagnostics()[0]).toMatchObject({
        status: "active",
        allocationError: "Shadow allocation WebGL errors: 0x505",
      });
      expect(controller.metrics()).toEqual({ bytes: shadowAtlasBytes(scene), passes: 6 });
      expect(sceneRenderingSettings(scene).shadows).toEqual(authored);
      expect(framebuffer).toBe(previousFramebuffer);
      const errorReads = gl.getError.mock.calls.length;
      controller.sync();
      expect(controller.generator(light)).toBe(retained);
      expect(allocation).toHaveBeenCalledTimes(2);
      expect(gl.getError).toHaveBeenCalledTimes(errorReads);
    } finally {
      if (engineGl) Object.defineProperty(engine, "_gl", engineGl);
      else Reflect.deleteProperty(engine, "_gl");
    }
  });

  it("propagates cleanup failure without attempting another allocation", () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    const light = new PointLight("point", Vector3.Zero(), scene);
    controller.register(light, true);
    // The first tile makes the atlas.
    const allocate = engine.createRenderTargetTexture.bind(engine);
    let restoreFailedDispose: (() => void) | undefined;
    const allocation = vi
      .spyOn(engine, "createRenderTargetTexture")
      .mockImplementationOnce((...args) => {
        const target = allocate(...args);
        const failedDispose = vi
          .spyOn(target, "dispose")
          .mockImplementationOnce(() => {
            throw new Error("driver cleanup failed");
          });
        restoreFailedDispose = () => failedDispose.mockRestore();
        throw new Error("driver allocation failed");
      });
    try {
      expect(() => controller.sync()).toThrow(
        "Shadow allocation and resource cleanup failed",
      );
      expect(allocation).toHaveBeenCalledTimes(1);
      expect(controller.diagnostics([light])[0]!.status).toBe("allocation-failed");
    } finally {
      restoreFailedDispose?.();
    }
  });
});

/** Every cascade's light transform as plain numbers (the generator reuses its matrices). */
function cascadeFit(generator: CascadedShadowGenerator): number[][] {
  return Array.from({ length: generator.numCascades }, (_, layer) => [...generator.getCascadeTransformMatrix(layer)!.m]);
}

/**
 * The kind of a shadow-depth variant, undefined for any other Effect: the sun's cascades, or a local light's, which a
 * spot light's tile and a point light's faces share (`AtlasShadowGenerator` names no light class).
 */
const depthKind = (effect: Effect): "sun" | "local" | undefined =>
  !/#define SM_FLOAT\b/.test(effect.defines) ? undefined : /SM_LIGHTTYPE_DIRECTIONALLIGHT\b/.test(effect.defines) ? "sun" : "local";

describe("atlas caster variants", () => {
  it.each([1, 2])("hold each atlas kind's caster depth variant that a first shadow start then draws with (%i cascades)", async (cascades) => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades, maxLocalLights: 2 }) });
    // Posed with a non-uniform scale, as a level's floor is: its variant reads its world matrix.
    const crate = MeshBuilder.CreateBox("crate", { size: 1 }, scene);
    crate.scaling.set(6, 0.2, 6);
    controller.sync();
    const compiled = () => new Set(Object.values((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects));
    const before = compiled();
    // Babylon loads a new map's shaders first: a later sync asks again.
    controller.warmCasterVariants();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.sync();
    const held = [...compiled()].filter((effect) => !before.has(effect));
    expect(held.map(depthKind).sort()).toEqual(["local", "sun"]);
    expect(held.every((effect) => /NONUNIFORMSCALING/.test(effect.defines))).toBe(true);
    // The stand-ins hold nothing of the Scene's: no light, no atlas tile, no texture.
    expect([scene.lights.length, shadowAtlasBytes(scene), scene.textures.length]).toEqual([0, 0, 0]);
    // The first map of each light type draws its caster with a variant held: the point light's faces with the local one.
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    const spot = new SpotLight("spot", new Vector3(0, 4, 0), Vector3.Down(), 1, 2, scene);
    const lamp = new PointLight("lamp", new Vector3(2, 2, 0), scene);
    for (const light of [sun, spot, lamp]) controller.register(light, true);
    controller.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const drawnWith = (light: DirectionalLight | SpotLight | PointLight) => {
      const map = light.getShadowGenerator()!.getShadowMap()!;
      const pass = engine.currentRenderPassId;
      engine.currentRenderPassId = map.renderPassId;
      try {
        map.customIsReadyFunction!(crate, 0, true);
      } finally {
        engine.currentRenderPassId = pass;
      }
      return crate.subMeshes[0]!._getDrawWrapper(map.renderPassId)!.effect!;
    };
    expect([sun, spot, lamp].map((light) => isAtlasShadow(light.getShadowGenerator()))).toEqual([true, true, true]);
    expect([sun, spot, lamp].map((light) => held.includes(drawnWith(light)))).toEqual([true, true, true]);
  });

  it("holds the instanced depth variant of each atlas kind for a regular-instance batch", async () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    engine.getCaps().instancedArrays = true;
    // A glTF node instance and its source: the batch draws instanced, which outside a frame no visible instance says.
    const source = MeshBuilder.CreateBox("source", { size: 1 }, scene);
    source.createInstance("copy").position.x = 3;
    const variants = () => Object.values((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects)
      .flatMap((effect) => {
        const kind = depthKind(effect);
        return kind ? [`${kind} ${/#define INSTANCES\b/.test(effect.defines) ? "instanced" : "plain"}`] : [];
      }).sort();
    controller.sync();
    controller.warmCasterVariants();
    for (let frame = 0; frame < 3; frame++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.sync();
    }
    expect(variants()).toEqual(["local instanced", "local plain", "sun instanced", "sun plain"]);
  });

  it("asks a caster whose Material draws its depth through a wrapper until it holds its variants, then no more", async () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    // Authored World Position Offset and lattice deformation draw a caster's depth through a standalone wrapper of a
    // variant Material that no other pass draws: its first ask compiles that Material, a later one the depth variant,
    // which the wrapper holds itself.
    const crate = MeshBuilder.CreateBox("crate", { size: 1 }, scene);
    const material = crate.material = new StandardMaterial("offset", scene);
    const wrapper = material.shadowDepthWrapper =
      new ShadowDepthWrapper(new StandardMaterial("offset depth", scene), scene, { standalone: true });
    const asked = vi.spyOn(wrapper, "isReadyForSubMesh");
    const kinds = () => Object.values((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects)
      .map(depthKind).filter(Boolean).sort();
    controller.sync();
    controller.warmCasterVariants();
    for (let frame = 0; frame < 4; frame++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.sync();
    }
    expect(kinds()).toEqual(["local", "sun"]);
    asked.mockClear();
    for (let frame = 0; frame < 3; frame++) controller.sync();
    expect(asked).not.toHaveBeenCalled();
  });

  it("asks again for new shadow settings", async () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    MeshBuilder.CreateBox("crate", { size: 1 }, scene);
    const variants = () => Object.values((engine as unknown as { _compiledEffects: Record<string, Effect> })._compiledEffects)
      .filter((effect) => depthKind(effect) !== undefined);
    controller.warmCasterVariants();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.sync();
    expect(variants().map((effect) => /SM_NORMALBIAS (\d)/.exec(effect.defines)?.[1])).toEqual(["1", "1"]);
    // Without normal bias the casters draw other variants: the next syncs hold those too (Babylon releases the others
    // at a frame's end).
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ cascades: 1, maxLocalLights: 1, normalBias: 0 }) });
    controller.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.sync();
    expect(variants().filter((effect) => /SM_NORMALBIAS 0/.test(effect.defines))).toHaveLength(2);
  });

  it("keeps its maps through a change of the shadow level's label alone", async () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    MeshBuilder.CreateBox("crate", { size: 1 }, scene);
    controller.warmCasterVariants();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.sync();
    const textures = new Set(engine.getLoadedTexturesCache());
    const before = sceneRenderingSettings(scene).shadows;
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ ...before, preset: "custom" }) });
    expect(sceneRenderingSettings(scene).shadows).toEqual({ ...before, preset: "custom" });
    controller.sync();
    // Built again, the stand-in maps would allocate another private atlas.
    expect(engine.getLoadedTexturesCache().filter((texture) => !textures.has(texture))).toEqual([]);
  });
});

describe("view sun shadow maps", () => {
  /** The light block's path, Medium: the sun's `cascades` 2048 cascades in a 4096 atlas, and a capture's camera. */
  const atlasSun = (cascades: number) => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    // Low, whose cascades all take tiles of the map size: these fill the atlas exactly.
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ profile: "low", mapSize: 2048, localMapSize: 1024, cascades, maxLocalLights: 1 }) });
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    controller.register(sun, true);
    controller.sync();
    return { scene, engine, controller, sun, capture: new UniversalCamera("capture", new Vector3(20, 6, 20), scene) };
  };

  it("gives a capture its own sun cascades as tiles of the light block's atlas, which charge nothing and go with the claim", async () => {
    const { scene, engine, controller, sun, capture } = atlasSun(2);
    const reserved = managedRenderReservations(engine).reservedBytes;
    const claim = controller.attachView(capture);
    const own = sun.getShadowGenerator(capture) as AtlasCascadedShadowGenerator;
    expect(own).toBeInstanceOf(AtlasCascadedShadowGenerator);
    expect(own).not.toBe(sun.getShadowGenerator());
    expect(controller.viewBoundGenerator(sun, capture)).toBe(own);
    expect(own.getShadowMap()!.renderTarget).toBe(shadowAtlasTexture(scene).renderTarget);
    expect(tileSizes(own)).toEqual([2048, 2048]);
    // Its tiles hold what their last map drew until it draws.
    expect([own.getDarkness(), awaitsFirstDraw(own)]).toEqual([NEUTRAL_DARKNESS, true]);
    expect(managedRenderReservations(engine).reservedBytes).toBe(reserved);
    expect(controller.metrics()).toEqual({ passes: 4, bytes: shadowAtlasBytes(scene) });
    expect(unsupportedManagedShadows(scene)).toBeUndefined();
    await claim.release();
    expect(sun.getShadowGenerator(capture)).toBeNull();
    expect(own.getShadowMap()).toBeNull();
  });

  it("samples the scene view's sun cascades for a capture whose own find no room in the atlas", () => {
    const { controller, sun, capture } = atlasSun(4);
    // Four 2048 cascades fill the 4096 atlas.
    expect(tileSizes(sun.getShadowGenerator())).toEqual([2048, 2048, 2048, 2048]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      controller.attachView(capture);
      expect(sun.getShadowGenerator(capture)).toBeNull();
      expect(controller.viewBoundGenerator(sun, capture)).toBe(sun.getShadowGenerator());
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("does not fit the shadow atlas"));
    } finally {
      warn.mockRestore();
    }
  });

  it("leaves reflections whose own cascades find no room in the atlas unshadowed by the sun, warned once for them all", () => {
    const { scene, controller, sun } = atlasSun(4);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mirrors = [new PlanarMirrorCamera("mirror a", Vector3.Zero(), scene, false), new PlanarMirrorCamera("mirror b", Vector3.Zero(), scene, false)];
      for (const mirror of mirrors) controller.attachView(mirror);
      // No map of their own: the light block draws them no sun cascades (`isReflectionCamera`), never the scene view's.
      expect(mirrors.map((mirror) => [controller.viewHoldsMaps(mirror), sun.getShadowGenerator(mirror)])).toEqual([[false, null], [false, null]]);
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        '[render] Reflections draw "sun" unshadowed: their own sun maps do not fit the shadow atlas.',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("makes a capture's cascades give way before a scene view's map would shrink for atlas room, and take what it leaves", () => {
    const { scene, controller, sun, capture } = atlasSun(2);
    controller.attachView(capture);
    // The scene view's and the capture's cascades fill the atlas.
    expect(tileSizes(sun.getShadowGenerator(capture))).toEqual([2048, 2048]);
    const spot = new SpotLight("spot", new Vector3(0, 4, -4), new Vector3(0, -1, 0.5), 1, 1, scene);
    controller.register(spot, true);
    controller.sync();
    expect((spot.getShadowGenerator() as AtlasShadowGenerator).tile.size).toBe(1024);
    expect(tileSizes(sun.getShadowGenerator(capture))).toEqual([1024, 1024]);
  });

  it("follows the scene view's sun map into an atlas of another edge, and goes with it, the atlas with them", () => {
    const { scene, engine, controller, sun, capture } = atlasSun(2);
    Object.assign(engine.getCaps(), { maxTextureSize: 8192 });
    controller.attachView(capture);
    const medium = sun.getShadowGenerator(capture);
    // High's 8192 atlas: both maps go with the 4096 one; from the next frame the scene view's map is rebuilt in it, and
    // the capture's after it.
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ profile: "high", cascades: 2, maxLocalLights: 1 }) });
    controller.sync();
    expect([medium!.getShadowMap(), sun.getShadowGenerator(capture), shadowAtlasBytes(scene)]).toEqual([null, null, 0]);
    endFrame(scene);
    controller.sync();
    const high = sun.getShadowGenerator(capture);
    expect(high).toBeInstanceOf(AtlasCascadedShadowGenerator);
    expect(atlasTextureEdge(scene)).toBe(8192);
    expect(tileSizes(high)).toEqual(tileSizes(sun.getShadowGenerator()));
    // The sun's shadow off: both maps go in the same sync, and the atlas with its last tile.
    controller.register(sun, false);
    controller.sync();
    expect([high!.getShadowMap(), sun.getShadowGenerator(capture)]).toEqual([null, null]);
    expect(shadowAtlasBytes(scene)).toBe(0);
  });
  it("releases every map, a view's own included, and the atlas on a reset, and makes them again in a later frame", () => {
    const { scene, controller, sun, capture } = atlasSun(1);
    controller.attachView(capture);
    const sceneMap = controller.generator(sun);
    const viewMap = sun.getShadowGenerator(capture);
    expect([sceneMap, viewMap].map((map) => map instanceof AtlasCascadedShadowGenerator)).toEqual([true, true]);
    expect(controller.refreshCensus().maps).toBe(2);
    // A sync with nothing asked keeps the atlas the first map made.
    endFrame(scene);
    controller.sync();
    expect(shadowAtlasGeneration(scene)).toBe(1);
    controller.resetAllocations();
    controller.sync();
    expect([controller.generator(sun), sun.getShadowGenerator(capture), shadowAtlasBytes(scene)]).toEqual([null, null, 0]);
    expect(controller.refreshCensus().maps).toBe(0);
    endFrame(scene);
    controller.sync();
    expect(shadowAtlasGeneration(scene)).toBe(2);
    expect(controller.generator(sun)).toBeInstanceOf(AtlasCascadedShadowGenerator);
    expect(controller.generator(sun)).not.toBe(sceneMap);
    expect(sun.getShadowGenerator(capture)).toBeInstanceOf(AtlasCascadedShadowGenerator);
    expect(controller.refreshCensus().maps).toBe(2);
    // One reset, one new atlas: the syncs after it keep it.
    endFrame(scene);
    controller.sync();
    expect(shadowAtlasGeneration(scene)).toBe(2);
    expect(controller.generator(sun)).not.toBeNull();
  });
  it("draws every map at half its edge with `shadowdebug fulltiles off` and back, in the same High atlas, never making another", () => {
    const { scene, controller } = fixture();
    Object.assign(scene.getEngine().getCaps(), { maxTextureSize: 8192 });
    updateSceneRenderingSettings(scene, { shadows: normalizeShadowSettings({ profile: "high" }) });
    const sun = new DirectionalLight("sun", new Vector3(0.2, -1, 0.3), scene);
    const spot = new SpotLight("spot", new Vector3(0, 4, -4), new Vector3(0, -1, 0.5), 1, 1, scene);
    controller.register(sun, true);
    controller.register(spot, true);
    controller.sync();
    const atlas = shadowAtlasRenderTarget(scene);
    const full = { sun: [4096, 2048, 2048, 1024], spot: [2048] };
    const sizes = () => ({ sun: tileSizes(controller.generator(sun)), spot: tileSizes(controller.generator(spot)) });
    expect([atlasTextureEdge(scene), shadowAtlasGeneration(scene), sizes()]).toEqual([8192, 1, full]);
    // As a Profile step runs it: the switch, the frames it is measured over, then the switch back and the frames after.
    expect(controller.setDebug("fulltiles", false)).toBe(true);
    for (let frame = 0; frame < 3; frame++) {
      endFrame(scene);
      controller.sync();
      expect(shadowAtlasRenderTarget(scene)).toBe(atlas);
      expect([shadowAtlasGeneration(scene), sizes()]).toEqual([1, { sun: [2048, 1024, 1024, 512], spot: [1024] }]);
    }
    expect(controller.setDebug("fulltiles", true)).toBe(true);
    for (let frame = 0; frame < 3; frame++) {
      endFrame(scene);
      controller.sync();
      expect(shadowAtlasRenderTarget(scene)).toBe(atlas);
      expect([atlasTextureEdge(scene), shadowAtlasGeneration(scene), sizes()]).toEqual([8192, 1, full]);
    }
  });
  it("mirrors each admitted sun map for an attached view, fitted to that view's camera, and shares local maps", async () => {
    const { scene, controller } = fixture();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 2, distance: 40, mapSize: 512, localMapSize: 256, maxLocalLights: 1 }),
    });
    const caster = MeshBuilder.CreateBox("caster", { size: 2 }, scene);
    const sun = new DirectionalLight("sun", new Vector3(0.4, -1, 0.6), scene);
    const spot = new SpotLight("spot", new Vector3(0, 4, -4), new Vector3(0, -1, 0.5), 1, 1, scene);
    controller.register(sun, true);
    controller.register(spot, true);
    controller.sync();
    const main = controller.generator(sun) as CascadedShadowGenerator;
    const local = controller.generator(spot)!;
    const capture = new UniversalCamera("capture", new Vector3(120, 6, 90), scene);
    capture.setTarget(new Vector3(120, 0, 100));
    const metrics = controller.metrics();
    const view = controller.attachView(capture);
    const own = controller.viewBoundGenerator(sun, capture) as CascadedShadowGenerator;
    // Stats count the view's two cascades; their tiles' bytes are the atlas's.
    expect(controller.metrics()).toEqual({ passes: metrics.passes + 2, bytes: metrics.bytes });
    // A map of the scene map's kind, tile size and cascades, keyed to the capture camera.
    expect(own).toBeInstanceOf(AtlasCascadedShadowGenerator);
    expect(own).not.toBe(main);
    expect(own.camera).toBe(capture);
    expect(own.numCascades).toBe(2);
    expect(tileSizes(own)).toEqual(tileSizes(main));
    expect(own.getShadowMap()!.renderList).toContain(caster);
    expect(sun.getShadowGenerator(capture)).toBe(own);
    expect(sun.getShadowGenerator()).toBe(main);
    // Point and spot maps do not depend on the view: it shares the scene's.
    expect(controller.viewBoundGenerator(spot, capture)).toBe(local);
    expect(unsupportedManagedShadows(scene)).toBeUndefined();
    // Each map fits its own camera; drawing one leaves the other's fit alone.
    prepareShadowLayers(main);
    const mainFit = cascadeFit(main);
    prepareShadowLayers(own);
    expect(cascadeFit(own)).not.toEqual(mainFit);
    expect(cascadeFit(main)).toEqual(mainFit);
    const ownFit = cascadeFit(own);
    prepareShadowLayers(main);
    expect(cascadeFit(own)).toEqual(ownFit);
    await view.release();
    expect(sun.getShadowGenerator(capture)).toBeNull();
    expect(own.getShadowMap()).toBeNull();
    // A camera-keyed map the controller does not own is still rejected.
    new ShadowGenerator(256, sun, undefined, capture);
    expect(unsupportedManagedShadows(scene)).toBe("Unmanaged shadow allocations are not supported.");
  });

  it("replaces a view's map with the scene map's allocation and releases it with the view", async () => {
    const { scene, controller } = fixture();
    const engine = scene.getEngine();
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 2, distance: 40, mapSize: 512 }),
    });
    const sun = new DirectionalLight("sun", new Vector3(0.4, -1, 0.6), scene);
    controller.register(sun, true);
    controller.sync();
    const capture = new UniversalCamera("capture", new Vector3(20, 6, 20), scene);
    const view = controller.attachView(capture);
    const first = controller.viewBoundGenerator(sun, capture)!;
    // A shadow settings change replaces the scene map, and the view's follows it.
    updateSceneRenderingSettings(scene, {
      shadows: normalizeShadowSettings({ cascades: 1, distance: 40, mapSize: 256 }),
    });
    controller.sync();
    const second = controller.viewBoundGenerator(sun, capture)!;
    expect(second).not.toBe(first);
    expect(first.getShadowMap()).toBeNull();
    expect((second as CascadedShadowGenerator).numCascades).toBe(1);
    expect(tileSizes(second)).toEqual(tileSizes(controller.generator(sun)));
    // Turning the sun's shadows off removes the view's map too.
    controller.register(sun, false);
    controller.sync();
    expect(controller.viewBoundGenerator(sun, capture)).toBeNull();
    expect(second.getShadowMap()).toBeNull();
    expect(sun.getShadowGenerator(capture)).toBeNull();
    controller.register(sun, true);
    controller.sync();
    const third = controller.viewBoundGenerator(sun, capture)!;
    expect(third.getShadowMap()).not.toBeNull();
    // A spot map admitted while the view is attached stays shared, never mirrored.
    const spot = new SpotLight("spot", new Vector3(0, 4, -4), new Vector3(0, -1, 0.5), 1, 1, scene);
    controller.register(spot, true);
    controller.sync();
    expect(controller.generator(spot)).not.toBeNull();
    expect(controller.viewBoundGenerator(spot, capture)).toBe(controller.generator(spot));
    expect(spot.getShadowGenerators()?.size).toBe(1);
    await view.release();
    expect(third.getShadowMap()).toBeNull();
    expect(sun.getShadowGenerator(capture)).toBeNull();
    // A view's maps never charge the shared ledger.
    expect(managedRenderReservations(engine)).toMatchObject({ resourceBytes: 0, pendingBytes: 0 });
    // A released view gets no new maps.
    controller.sync();
    expect(sun.getShadowGenerator(capture)).toBeNull();
  });
});
