import {
  CascadedShadowGenerator,
  DirectionalLight,
  PointLight,
  SpotLight,
  ShadowGenerator,
  Frustum,
  Plane,
  RenderTargetTexture,
  type AbstractMesh,
  type Light,
  type Scene,
  type Camera,
} from "@babylonjs/core";
import type { ShadowSettings } from "@haptic/core";
import { ReusableShadowGenerator, type LocalShadowLight } from "./reusable-shadow-generator";
import { casterWithinShadowRange, hasDeformingShadowBounds } from "./shadow-mesh-policy";
import type { ShadowSpatialIndex } from "./shadow-spatial-index";
import { trackShadowSlotDefines } from "./shadow-slot-defines";
import {
  casterNormalBias,
  resolveDirectionalShadowBias,
  type DirectionalShadowBiasInput,
} from "./shadow-bias";
import { configureDirectionalShadowProjection, trackDirectionalShadowFit } from "./directional-shadow-projection";
import { readEngineDrawCalls } from "./draw-calls";
import { beginShadowAllocationValidation } from "./shadow-allocation-validation";
import { beginEngineAllocationCheckpoint } from "./allocation-checkpoint";
import { awaitsFirstDraw, isWarmShadowRender, setAwaitingFirstDraw } from "./shadow-first-draw";
import { isRevealPending } from "./reveal-pending";
import { listsHiddenCaster } from "./shadow-caster-warm";
import type { EffectiveShadowBias, ShadowEntry as Entry } from "./shadow-entry";

// Every Babylon 9.29 shadow filter returns fully lit at darkness 1.
export const NEUTRAL_DARKNESS = 1;

/** A map's current owner; a local map can move between lights. `view`: a view's own sun map. */
export type ShadowMapSlot = { entry: Entry; view: boolean };
/** Draws and triangles the maps rendered this frame. */
export type ShadowDrawCounters = { drawCalls: number; triangles: number };
/** The controller state every map it builds reads and reports to. */
export interface ShadowMapContext {
  readonly scene: Scene;
  readonly spatial: ShadowSpatialIndex;
  /** Every shadow caster, which a new map lists. */
  readonly casters: ReadonlySet<AbstractMesh>;
  /** Per-map closures read their current owner; a local map can move between lights. */
  readonly slots: WeakMap<ShadowGenerator, ShadowMapSlot>;
  readonly counters: ShadowDrawCounters;
}

/**
 * A point/spot map's depth ends at the light's range, not the camera's far
 * plane: casters beyond it have no light to block, and the shorter range both
 * culls them per face and spends the depth precision where the light reaches.
 * A range at or beyond the camera's far plane uses the camera's values, written
 * explicitly: Babylon reads unset values from whichever camera renders, so a
 * second view (a Full Quality capture) would otherwise bind another depth range
 * than the one the map was drawn with. Only the scene view's camera fits.
 */
export function fitLocalShadowDepth(light: Light, camera: Camera | null): void {
  if (!(light instanceof PointLight || light instanceof SpotLight)) return;
  const far = camera?.maxZ || 10000;
  const ranged = Number.isFinite(light.range) && light.range > 0 && light.range < far;
  // Babylon 9.29's camera defaults, the same values the unset fields resolve to.
  const maxZ = ranged ? light.range : camera ? far : undefined;
  const minZ = camera ? camera.minZ || 0 : undefined;
  const depth = light as { shadowMinZ: number | undefined; shadowMaxZ: number | undefined };
  if (depth.shadowMaxZ !== maxZ) depth.shadowMaxZ = maxZ;
  if (depth.shadowMinZ !== minZ) depth.shadowMinZ = minZ;
}

/** Construction is synchronous: no other renderer can allocate between checkpoints. */
export function shadowAllocationCheckpoint(
  scene: Scene,
): (generator: { dispose(): void } | null) => void {
  const rollback = beginEngineAllocationCheckpoint(scene);
  return (generator) => {
    const failures = rollback({
      before: (attempt) => {
        if (generator) attempt(() => generator.dispose());
      },
      // A throwing RTT constructor has already registered itself and its observers
      // on the Scene, but has not returned into ShadowGenerator._shadowMap yet.
      textureFilter: (texture) => texture instanceof RenderTargetTexture,
    });
    if (failures.length)
      throw new AggregateError(
        failures,
        "Could not release a failed shadow allocation",
      );
  };
}

/**
 * Constructs one admitted map with every hook the controller relies on:
 * receiver defines, automatic bias, culled caster lists and draw counters.
 * `view` keys a sun map to a view's camera (attachView); null is the scene
 * view's map, which receivers of every other camera bind.
 */
export function createShadowGenerator(
  context: ShadowMapContext,
  entry: Entry,
  mapSize: number,
  settings: ShadowSettings,
  view: Camera | null,
  casterBounds: ReturnType<ShadowSpatialIndex["bounds"]> | undefined,
): ShadowGenerator {
  const scene = context.scene;
  const directionalLight = entry.light instanceof DirectionalLight;
  const validateAllocation = beginShadowAllocationValidation(
    scene.getEngine(),
  );
  // A view's map is keyed to its camera; the scene view's to the null camera.
  const camera = view ?? undefined;
  const generator =
    directionalLight && settings.cascades > 1
      ? new CascadedShadowGenerator(
          mapSize,
          entry.light as DirectionalLight,
          undefined,
          camera,
        )
      : directionalLight
        ? new ShadowGenerator(mapSize, entry.light, undefined, camera)
        : new ReusableShadowGenerator(mapSize, entry.light as LocalShadowLight);
  const slot = { entry, view: view !== null };
  context.slots.set(generator, slot);
  if (generator instanceof CascadedShadowGenerator) {
    generator.numCascades = settings.cascades;
    generator.stabilizeCascades = true;
    generator.lambda = 0.7;
    generator.shadowMaxZ = settings.distance;
    generator.cascadeBlendPercentage = 0.05;
    generator.autoCalcDepthBounds = false;
    generator.depthClamp = true;
    generator.freezeShadowCastersBoundingInfo = true;
    if (casterBounds)
      generator.shadowCastersBoundingInfo.reConstruct(
        casterBounds.min,
        casterBounds.max,
      );
  } else if (entry.light instanceof DirectionalLight) {
    // The light's one builder fits each of its generators to its own camera.
    if (!view)
      configureDirectionalShadowProjection(
        entry.light,
        scene,
        settings.distance,
        mapSize,
        context.spatial,
      );
    trackDirectionalShadowFit(generator);
  }
  applyShadowSettings(generator, settings);
  const prepare = generator.prepareDefines.bind(generator);
  generator.prepareDefines = (defines, lightIndex) => {
    prepare(defines, lightIndex);
    // Both values come from the generator in the slot now: a slot's previous
    // cascaded map must not leave its fade behind.
    defines[`SLATE_SHADOW_AUTO${lightIndex}`] =
      directionalLight && slot.entry.settings!.autoBias && generator.usePercentageCloserFiltering;
    defines[`SLATE_SHADOW_FADE${lightIndex}`] =
      generator instanceof CascadedShadowGenerator && slot.entry.settings!.fadeFraction;
    defines.rebuild();
    trackShadowSlotDefines(defines, lightIndex);
  };
  validateAllocation(generator);
  const map = generator.getShadowMap();
  // The new map's list is empty and the casters are unique, so skip
  // addShadowCaster's per-mesh indexOf scan. The constructor has already
  // light-dirtied every mesh that can bind this light's shadow defines.
  if (map) map.renderList = Array.from(context.casters);
  let drawsBefore = 0;
  let indicesBefore = 0;
  map?.onBeforeBindObservable.add(() => {
    drawsBefore = readEngineDrawCalls(scene.getEngine());
    indicesBefore = scene.getActiveIndices();
  });
  map?.onAfterUnbindObservable.add(() => {
    // A warm render draws nothing, but Babylon counts a skipped draw's indices before it reaches the pipeline.
    if (isWarmShadowRender(generator)) return;
    context.counters.drawCalls += Math.max(
      0,
      readEngineDrawCalls(scene.getEngine()) - drawsBefore,
    );
    context.counters.triangles +=
      Math.max(0, scene.getActiveIndices() - indicesBefore) / 3;
  });
  if (generator instanceof CascadedShadowGenerator)
    map?.onBeforeBindObservable.add(
      () => generator.splitFrustum(),
      -1,
      true,
    );
  // Registered after Babylon 9.29's native observer: single-map view /
  // projection and the CSM layer are current, caster uniforms are not
  // bound yet. Never derive from the previous frame in applyShadowSettings.
  let preparedBias: EffectiveShadowBias | null = null;
  let clearedForDraw = false;
  let layerTexelSize = 0;
  // The resolver reads its input synchronously; each map reuses one.
  const biasInput: DirectionalShadowBiasInput = {
    width: 0, height: 0, depth: 0, mapWidth: 0, mapHeight: 0, filter: "none", filterQuality: "low",
    poissonRadiusTexels: 0, depthClamp: false, authoredDepthBias: 0, authoredNormalBias: 0,
  };
  map?.onBeforeRenderObservable.add((layer) => {
    clearedForDraw = false;
    const settings = slot.entry.settings!;
    const automatic = settings.autoBias && directionalLight;
    const projection = generator instanceof CascadedShadowGenerator
      ? generator.getCascadeProjectionMatrix(layer)
      : generator.projectionMatrix;
    const size = map.getSize();
    const matrix = projection?.m;
    biasInput.width = automatic && scene.activeCamera && matrix ? Math.abs(2 / matrix[0]) : 0;
    biasInput.height = automatic && scene.activeCamera && matrix ? Math.abs(2 / matrix[5]) : 0;
    biasInput.depth = matrix ? Math.abs((scene.getEngine().isNDCHalfZRange ? 1 : 2) / matrix[10]) : 0;
    biasInput.mapWidth = size.width;
    biasInput.mapHeight = size.height;
    biasInput.filter = generator.usePercentageCloserFiltering ? "pcf"
      : generator.useContactHardeningShadow ? "pcss"
        : generator.usePoissonSampling ? "poisson" : "none";
    biasInput.filterQuality = generator.filteringQuality === ShadowGenerator.QUALITY_HIGH ? "high"
      : generator.filteringQuality === ShadowGenerator.QUALITY_MEDIUM ? "medium" : "low";
    biasInput.poissonRadiusTexels = generator.blurScale;
    biasInput.depthClamp = generator instanceof CascadedShadowGenerator && generator.depthClamp;
    biasInput.authoredDepthBias = settings.depthBias;
    biasInput.authoredNormalBias = settings.normalBias;
    const effective = resolveDirectionalShadowBias(biasInput);
    generator.bias = effective.bias;
    generator.normalBias = effective.normalBias;
    const record = preparedBias ??= {
      layer, cameraId: null, renderId: -1, depthBias: 0, normalBias: 0, worldTexelSize: 0, depthScale: 0,
      mode: "manual",
    };
    record.layer = layer;
    record.depthBias = effective.bias;
    record.cameraId = (generator.camera ?? scene.activeCamera)?.id ?? null;
    record.renderId = scene.getRenderId();
    record.normalBias = effective.normalBias;
    record.worldTexelSize = effective.worldTexelSize;
    record.depthScale = effective.depthScale;
    record.mode = !settings.autoBias ? "manual" : automatic ? "directional-auto" : "local-authored";
    layerTexelSize = automatic ? effective.worldTexelSize : 0;
  });
  // Babylon binds biasAndScaleSM per caster just before these observers run.
  let caster: AbstractMesh | null = null;
  generator.onBeforeShadowMapRenderMeshObservable.add((mesh) => { caster = mesh; });
  generator.onBeforeShadowMapRenderObservable.add((effect) => {
    const normalBias = caster ? casterNormalBias(caster, generator.normalBias, layerTexelSize) : generator.normalBias;
    if (normalBias !== generator.normalBias) effect.setFloat3("biasAndScaleSM", generator.bias, normalBias, generator.depthScale);
  });
  // Native readiness probes emit before/after-render without drawing.
  // Only actual RTT passes (including empty maps and snapshot rendering)
  // emit clear before their successful after-render notification. Keep
  // prepared values private until that pass has finished, so evidence
  // cannot relabel a cached map after another camera's readiness probe.
  map?.onClearObservable.add(() => { clearedForDraw = true; });
  map?.onAfterRenderObservable.add((face) => {
    if (!clearedForDraw) return;
    clearedForDraw = false;
    // A warm render (`shadow-map-warm.ts`) skips its draws: it is no first draw.
    if (isWarmShadowRender(generator)) return;
    // A new, moved or resumed map samples neutrally until its last face is drawn.
    if (awaitsFirstDraw(generator) && face === (map.isCube ? 5 : 0)) {
      setAwaitingFirstDraw(generator, false);
      if (!slot.entry.standby) generator.setDarkness(0);
    }
    // Effective bias reports the scene view's maps.
    if (!preparedBias || slot.view) return;
    const record = slot.entry.effectiveBias[preparedBias.layer] ??= { ...preparedBias };
    Object.assign(record, preparedBias);
    record.depthBias = generator.bias;
    record.normalBias = generator.normalBias;
  });
  let activePlanes: Plane[] | null = null;
  // Babylon consumes each custom list synchronously, so every map reuses
  // its planes and caster list; upstream views the same side/far planes.
  const planes = Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0));
  const upstream = planes.slice(1);
  const casters: AbstractMesh[] = [];
  if (map)
    map.getCustomRenderList = (layer) => {
      const transform =
        generator instanceof CascadedShadowGenerator
          ? generator.getCascadeTransformMatrix(layer)
          : generator.getTransformMatrix();
      if (!transform) return null;
      Frustum.GetPlanesToRef(transform, planes);
      activePlanes =
        directionalLight && slot.entry.settings!.filter === "pcf"
          ? upstream
          : planes;
      context.spatial.queryPlanes(activePlanes, casters);
      // The index never plane-culls deforming casters. A local map ends
      // at its light's range, so anything that cannot reach it draws nothing.
      // A mesh a world view does not draw yet casts nothing either; on WebGPU
      // a steady frame lists it while its reveal waits for this map, only to
      // create its depth pipelines, every draw of it skipped
      // (`shadow-caster-warm.ts`).
      const light = generator.getLight();
      const range = !directionalLight && "range" in light && Number.isFinite(light.range) ? light.range as number : undefined;
      const position = range === undefined ? undefined : (light as LocalShadowLight).getAbsolutePosition();
      let kept = 0;
      for (const mesh of casters)
        if ((!isRevealPending(mesh) || listsHiddenCaster(generator, mesh)) &&
          (!position || casterWithinShadowRange(mesh, position, range!))) casters[kept++] = mesh;
      casters.length = kept;
      return casters;
    };
  generator.customAllowRendering = (part) => {
    if (hasDeformingShadowBounds(part.getMesh())) return true;
    // Babylon draws a mesh's instances in its parts' batches: culled by the mesh's own box, they would draw where it is.
    if (part.getRenderingMesh().hasInstances) return true;
    if (!activePlanes || part.getMesh().subMeshes.length < 2)
      return true;
    const box = part.getBoundingInfo()?.boundingBox;
    if (!box) return true;
    for (const plane of activePlanes) {
      const n = plane.normal;
      if (
        n.x * (n.x >= 0 ? box.maximumWorld.x : box.minimumWorld.x) +
          n.y * (n.y >= 0 ? box.maximumWorld.y : box.minimumWorld.y) +
          n.z * (n.z >= 0 ? box.maximumWorld.z : box.minimumWorld.z) +
          plane.d <
        0
      )
        return false;
    }
    return true;
  };
  return generator;
}

/** Keep a new, moved or resumed map from sampling empty or stale depth before it draws. */
export function neutralUntilRendered(generator: ShadowGenerator): void {
  generator.setDarkness(NEUTRAL_DARKNESS);
  setAwaitingFirstDraw(generator, true);
  generator.getShadowMap()?.resetRefreshCounter();
}

export function applyShadowSettings(
  generator: ShadowGenerator,
  settings: ShadowSettings,
): void {
  generator.filter =
    settings.filter === "pcss"
      ? ShadowGenerator.FILTER_PCSS
      : ShadowGenerator.FILTER_PCF;
  generator.contactHardeningLightSizeUVRatio = settings.softness;
  generator.filteringQuality =
    settings.filterQuality === "high"
      ? ShadowGenerator.QUALITY_HIGH
      : settings.filterQuality === "medium"
        ? ShadowGenerator.QUALITY_MEDIUM
        : ShadowGenerator.QUALITY_LOW;
  generator.bias = settings.depthBias;
  generator.normalBias = settings.normalBias;
  generator.frustumEdgeFalloff = 0;
}
