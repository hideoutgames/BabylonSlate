import { syncSceneRenderPath, publishSceneRenderPath } from "./scene-render-path";
import "./texture-quality";
import { lightsInCreationOrder, syncForwardLightPolicy } from "./light-policy";
import { forwardLightBudget } from "./forward-light-budget";
import { lightingSamplerCapacity } from "./light-sampler-budget";
import {
  clusteredLightingLimits,
  clusteredLocalContributionCount,
  syncClusteredLightPolicy,
} from "./clustered-light-policy";
import { sceneRenderingSettings } from "./render-settings";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import {
  takeShadowReceiverHandoffs,
  type ShadowReceiverHandoff,
} from "./shadow-receiver-handoff";
import type { ForwardLightSlotExchange } from "./forward-light-slots";
import {
  LightBlock,
  Material,
  NodeMaterial,
  NodeMaterialModes,
  PBRMetallicRoughnessBlock,
  RectAreaLight,
  type Light,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import { CelLightBlock } from "./cel-light-block";

type LitMaterial = Material & { maxSimultaneousLights: number };

function isLitMaterial(material: Material): material is LitMaterial {
  if (!("maxSimultaneousLights" in material)) return false;
  if ("disableLighting" in material && material.disableLighting === true)
    return false;
  if ("unlit" in material && material.unlit === true) return false;
  if (material instanceof NodeMaterial) {
    return (
      material.mode === NodeMaterialModes.Material &&
      material.attachedBlocks.some(
        (block) =>
          // instanceof, not class name: app subclasses (ScenePbrLightingBlock)
          // report their own name for NodeMaterial clone round-trips.
          block instanceof PBRMetallicRoughnessBlock ||
          block instanceof CelLightBlock ||
          block instanceof LightBlock,
      )
    );
  }
  return typeof material.maxSimultaneousLights === "number";
}

type SceneLighting = { sync: () => void; invalidate: () => void; limits: () => string[] };

// Shadow layout tokens per enabled light: shadowEnabled, generator, area
// emission texture, area emission readiness.
const LAYOUT_STRIDE = 4;

/**
 * Whether index-preserving light changes that left every receiver define
 * unchanged explain every difference between the previous and next
 * snapshots: same-kind shadow map moves since the last sync, which exchanged
 * the lights' shader indices, then this sync's Forward slot exchanges, which
 * put an identical light in a dropped light's index.
 */
function explainedBySlotChanges(
  handoffs: readonly ShadowReceiverHandoff[],
  exchanges: readonly ForwardLightSlotExchange[],
  lights: readonly Light[],
  layout: readonly unknown[],
  nextLights: readonly Light[],
  nextLayout: readonly unknown[],
): boolean {
  const expectedLights = lights.slice();
  const expected = layout.slice();
  for (const { from, to, generator } of handoffs) {
    const a = expectedLights.indexOf(from);
    const b = expectedLights.indexOf(to);
    if (
      a < 0 ||
      b < 0 ||
      expected[a * LAYOUT_STRIDE + 1] !== generator ||
      expected[b * LAYOUT_STRIDE + 1] !== null
    )
      return false;
    expectedLights[a] = to;
    expectedLights[b] = from;
    for (let token = 0; token < LAYOUT_STRIDE; token++) {
      const value = expected[a * LAYOUT_STRIDE + token];
      expected[a * LAYOUT_STRIDE + token] = expected[b * LAYOUT_STRIDE + token];
      expected[b * LAYOUT_STRIDE + token] = value;
    }
    // The map keeps its shader index; only its light changed places.
    expected[a * LAYOUT_STRIDE + 1] = generator;
    expected[b * LAYOUT_STRIDE + 1] = null;
  }
  for (const { from, to, preserved } of exchanges) {
    const index = expectedLights.indexOf(from);
    if (!preserved || index < 0) return false;
    // Same slot defines and no shadow map, so the layout tokens stay too.
    expectedLights[index] = to;
  }
  return (
    expectedLights.length === nextLights.length &&
    expectedLights.every((light, index) => light === nextLights[index]) &&
    expected.length === nextLayout.length &&
    expected.every((token, index) => token === nextLayout[index])
  );
}
const lightingByScene = new WeakMap<Scene, SceneLighting>();

/**
 * Bound conventional shader variants before compilation, then select effective
 * lights within that budget without changing authored Enabled values.
 */
export function syncSceneLighting(scene: Scene): void {
  let lighting = lightingByScene.get(scene);
  if (!lighting) {
    lighting = installSceneLighting(scene);
    lightingByScene.set(scene, lighting);
  }
  lighting.sync();
}

/**
 * Re-apply the light-slot capacity at the next sync, e.g. when a material
 * starts using scene lights again. No-op where lighting is not managed.
 */
export function invalidateSceneLighting(scene: Scene): void {
  lightingByScene.get(scene)?.invalidate();
}

export function sceneLightingLimits(scene: Scene): string[] {
  return [
    ...scene.lights.flatMap((light) => typeof light.metadata?.areaLight?.error === "string" ? [`${light.name}: ${light.metadata.areaLight.error}`] : []),
    ...clusteredLightingLimits(scene),
    ...(lightingByScene.get(scene)?.limits() ?? []),
  ];
}

function installSceneLighting(scene: Scene): SceneLighting {
  let dirty = true;
  let lightCount = -1;
  let materialCount = -1;
  let sceneLightsEnabled = scene.lightsEnabled;
  let sceneShadowsEnabled = scene.shadowsEnabled;
  // The most lights the Scene has held, enabled or not; it never shrinks.
  let lightInventory = 0;
  let enabledLights: Light[] = [];
  let nextEnabled: Light[] = [];
  let shadowLayout: unknown[] = [];
  let nextShadowLayout: unknown[] = [];
  let admission: ReturnType<typeof syncForwardLightPolicy> = {
    requested: 0,
    admitted: 0,
    limited: [],
    samplerLimited: [],
    samplers: 0,
    exchanges: [],
  };
  let budget = forwardLightBudget(scene.getEngine());
  const watchedLights = new Map<Light, Observer<boolean>>();
  const invalidate = () => {
    dirty = true;
  };
  // Enabled changes the Forward policy makes are judged after it returns: a
  // preserved slot exchange already left every receiver's shader valid.
  let policyToggles: Set<Light> | undefined;
  const toggled = new Set<Light>();
  const watchLight = (light: Light) => () => {
    if (policyToggles) policyToggles.add(light);
    else dirty = true;
  };
  const isPreservedExchange = (light: Light) =>
    admission.exchanges.some(
      (exchange) =>
        exchange.preserved && (exchange.from === light || exchange.to === light),
    );

  const sync = (): void => {
    if (scene.isDisposed) return;
    syncSceneRenderPath(scene);
    syncClusteredLightPolicy(scene);
    publishSceneRenderPath(scene);
    budget = forwardLightBudget(scene.getEngine());
    // Selection precedes the collection fast path: camera/light movement and
    // priority changes need no scene membership or Enabled event.
    policyToggles = toggled;
    try {
      admission = syncForwardLightPolicy(
        scene,
        budget.slots,
        Math.max(
          0,
          sceneRenderingSettings(scene).localLightBudget -
            clusteredLocalContributionCount(scene),
        ),
      );
    } finally {
      policyToggles = undefined;
    }
    if (toggled.size) {
      for (const light of toggled)
        if (!isPreservedExchange(light)) {
          dirty = true;
          break;
        }
      toggled.clear();
    }
    nextEnabled.length = 0;
    nextShadowLayout.length = 0;
    for (const light of scene.lights) {
      if (!light.isEnabled()) continue;
      nextEnabled.push(light);
      nextShadowLayout.push(
        light.shadowEnabled,
        light.getShadowGenerator(scene.activeCamera) ??
          light.getShadowGenerator(),
        light instanceof RectAreaLight ? light.emissionTexture : null,
        light instanceof RectAreaLight ? light.emissionTexture?.isReady() : false,
      );
    }
    const handoffs = takeShadowReceiverHandoffs(scene);
    const changed =
      sceneLightsEnabled !== scene.lightsEnabled ||
      sceneShadowsEnabled !== scene.shadowsEnabled ||
      nextEnabled.length !== enabledLights.length ||
      nextEnabled.some((light, index) => light !== enabledLights[index]) ||
      nextShadowLayout.length !== shadowLayout.length ||
      nextShadowLayout.some((entry, index) => entry !== shadowLayout[index]);
    // Babylon defers its new-entity observables. These O(1) checks also catch
    // objects constructed immediately before prewarm or the first render.
    if (
      !dirty &&
      lightCount === scene.lights.length &&
      materialCount === scene.materials.length &&
      (!changed ||
        (sceneLightsEnabled === scene.lightsEnabled &&
          sceneShadowsEnabled === scene.shadowsEnabled &&
          !handoffs?.invalid &&
          (!!handoffs?.handoffs.length || admission.exchanges.length > 0) &&
          explainedBySlotChanges(
            handoffs?.handoffs ?? [],
            admission.exchanges,
            enabledLights,
            shadowLayout,
            nextEnabled,
            nextShadowLayout,
          )))
    ) {
      if (!changed) return;
      // Receivers already bind the exchanged order with unchanged effects.
      [enabledLights, nextEnabled] = [nextEnabled, enabledLights];
      [shadowLayout, nextShadowLayout] = [nextShadowLayout, shadowLayout];
      return;
    }
    dirty = false;
    // Light membership/shadow layout changed; the cached strict readiness
    // result no longer describes the effects these materials will build.
    markSceneReadinessDirty(scene);
    lightCount = scene.lights.length;
    materialCount = scene.materials.length;
    sceneLightsEnabled = scene.lightsEnabled;
    sceneShadowsEnabled = scene.shadowsEnabled;
    const liveLights = new Set(scene.lights);
    for (const [light, observer] of watchedLights) {
      if (liveLights.has(light)) continue;
      light.onEffectiveEnabledStateChangedObservable.remove(observer);
      watchedLights.delete(light);
    }
    for (const light of liveLights) {
      if (watchedLights.has(light)) continue;
      watchedLights.set(
        light,
        light.onEffectiveEnabledStateChangedObservable.add(watchLight(light)),
      );
    }
    const previousEnabled = enabledLights;
    enabledLights = nextEnabled;
    nextEnabled = previousEnabled;
    const previousShadowLayout = shadowLayout;
    shadowLayout = nextShadowLayout;
    nextShadowLayout = previousShadowLayout;
    // Sized by the light inventory, not the enabled count: turning lights on
    // or off and budget swaps keep MAXLIGHTCOUNT, so a receiver whose own
    // lights are unchanged keeps its Effect. Not the slot count either: Babylon
    // expands every per-light include this many times before dropping the
    // unused copies, and that JS cost is paid per Effect.
    lightInventory = Math.max(lightInventory, scene.lights.length);
    const capacity = Math.min(budget.slots, Math.max(4, lightInventory));
    const blocked = scene.blockMaterialDirtyMechanism;
    scene.blockMaterialDirtyMechanism = false;
    try {
      for (const material of scene.materials) {
        if (!isLitMaterial(material)) continue;
        if (!changed && material.maxSimultaneousLights === capacity) continue;
        material.maxSimultaneousLights = capacity;
        material.markAsDirty(Material.LightDirtyFlag);
        // Light defines alone do not invalidate a frozen material's cached
        // readiness, including when a disposed generator removes SHADOW defines.
        // Preserve its freeze policy while refreshing the shader.
        material.markDirty();
      }
    } finally {
      scene.blockMaterialDirtyMechanism = blocked;
    }
  };

  const beforeRender = scene.onBeforeRenderObservable.add(sync);
  const lightAdded = scene.onNewLightAddedObservable.add(invalidate);
  const lightRemoved = scene.onLightRemovedObservable.add(invalidate);
  const materialAdded = scene.onNewMaterialAddedObservable.add(invalidate);
  const materialRemoved = scene.onMaterialRemovedObservable.add(invalidate);
  const restored = scene
    .getEngine()
    .onContextRestoredObservable.add(invalidate);
  scene.onDisposeObservable.addOnce(() => {
    scene.onBeforeRenderObservable.remove(beforeRender);
    scene.onNewLightAddedObservable.remove(lightAdded);
    scene.onLightRemovedObservable.remove(lightRemoved);
    scene.onNewMaterialAddedObservable.remove(materialAdded);
    scene.onMaterialRemovedObservable.remove(materialRemoved);
    scene.getEngine().onContextRestoredObservable.remove(restored);
    for (const [light, observer] of watchedLights) {
      light.onEffectiveEnabledStateChangedObservable.remove(observer);
    }
    watchedLights.clear();
    lightingByScene.delete(scene);
  });
  return {
    sync,
    invalidate,
    limits: () =>
      admission.limited.length
        ? [
            `Conventional lighting: ${admission.admitted}/${admission.requested} requested lights admitted; ${sceneRenderingSettings(scene).localLightBudget} scalability local lights; ${budget.slots} shader slots (${budget.source}, ${budget.reservedBlocks} non-light blocks reserved); ${admission.samplers}/${lightingSamplerCapacity(scene)} lighting samplers, ${admission.samplerLimited.length} limited by sampler headroom. Limited: ${lightsInCreationOrder(admission.limited)
              .slice(0, 16)
              .map((light) => light.name)
              .join(", ")}${admission.limited.length > 16 ? ", …" : ""}`,
          ]
        : [],
  };
}
