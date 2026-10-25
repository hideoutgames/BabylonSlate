import {
  PointLight,
  SpotLight,
  type ShadowGenerator,
  type Vector3,
  type Light,
  type Scene,
} from "@babylonjs/core";
import { SHADOW_CAPACITY_PROFILES, type ShadowSettings } from "@haptic/core";
import { setAwaitingFirstDraw } from "./shadow-first-draw";
import {
  ENGINE_SHADOW_BUDGET,
  otherShadowReservations,
  availableSceneShadowBytes,
  reserveSceneShadows,
  shadowBytesPerTexel,
  type ShadowCost,
} from "./shadow-admission";
import type { ShadowEntry as Entry } from "./shadow-entry";
import { createShadowGenerator, type ShadowMapContext } from "./shadow-map-factory";

/**
 * A prediction map's size (decision 6): a map's format, filter and kind shape the variants it compiles and the
 * pipelines it warms, never its size.
 */
export const PREDICTION_MAP_SIZE = 64;

/**
 * A scene's prediction maps (`SceneShadowController.predictionMap`), one per light kind, and the scene's shadow
 * reservation: the real maps' cost the last sync reserved, with the prediction maps' bytes.
 */
export class ShadowPredictionMaps {
  /** The real maps' cost the last sync reserved. */
  reserved: ShadowCost = { bytes: 0, passes: 0, samplers: 0 };
  /** Prediction maps by light kind (`map`), with the settings they were built with and their bytes. */
  private readonly held = new Map<string, { generator: ShadowGenerator; key: string; bytes: number }>();
  private readonly maps: ShadowMapContext;
  private readonly scene: Scene;
  /** The effective settings the last sync admitted by. */
  private readonly settings: () => ShadowSettings | null;
  constructor(maps: ShadowMapContext, settings: () => ShadowSettings | null) {
    this.maps = maps;
    this.scene = maps.scene;
    this.settings = settings;
  }
  /** `SceneShadowController.predictionMap`. */
  map(light: Light): ShadowGenerator | null {
    const settings = this.settings();
    if (!settings?.enabled || !(light instanceof SpotLight || light instanceof PointLight)) return null;
    const kind = `${light.getClassName()}:${light.needCube()}`;
    const key = JSON.stringify(settings);
    let held = this.held.get(kind);
    if (held && held.key !== key) {
      const stale = held.generator;
      this.release((other) => other === stale);
      held = undefined;
    }
    if (!held) {
      const engine = this.scene.getEngine();
      const bytes = (light.needCube() ? 6 : 1) * PREDICTION_MAP_SIZE ** 2 * shadowBytesPerTexel(engine);
      const room = Math.min(SHADOW_CAPACITY_PROFILES[settings.profile].byteBudget,
        ENGINE_SHADOW_BUDGET.bytes - otherShadowReservations(this.scene).bytes, availableSceneShadowBytes(this.scene));
      if (this.reserved.bytes + this.predictionBytes() + bytes > room) return null;
      const entry: Entry = {
        light, requested: true, priority: 0, generator: null, key: null, settings, mapSize: PREDICTION_MAP_SIZE,
        reason: null, failedKey: "", recovery: null, resetAllocation: false, status: "disabled", standby: false,
        admittedAt: -Infinity, distanceSquared: 0, effectiveBias: [],
      };
      // Kept out of the scene's texture list as well as off the light: views count the scene's textures, and one
      // added would ask each for a strict readiness probe. A lost context releases it (`restored` in the controller).
      const scene = this.scene as unknown as { _blockEntityCollection: boolean };
      const blocked = scene._blockEntityCollection;
      scene._blockEntityCollection = true;
      // A light holding a standby map keeps it: a new generator replaces its light's map for the same camera key.
      const attached = light._shadowGenerators;
      const holding = attached ? [...attached] : [];
      let generator: ShadowGenerator;
      try {
        generator = createShadowGenerator(this.maps, entry, PREDICTION_MAP_SIZE, settings, null, undefined);
      } finally {
        scene._blockEntityCollection = blocked;
      }
      this.maps.slots.delete(generator);
      detachShadowGenerator(generator);
      if (attached && holding.length) {
        light._shadowGenerators = attached;
        for (const [camera, owner] of holding) attached.set(camera, owner);
      }
      setAwaitingFirstDraw(generator, false);
      held = { generator, key, bytes };
      this.held.set(kind, held);
      this.reserve();
    }
    // Aimed at the light it predicts (its casters' culling and projection), and listing the casters as they are now.
    aimShadowGenerator(held.generator, light);
    const map = held.generator.getShadowMap();
    if (map) map.renderList = Array.from(this.maps.casters);
    return held.generator;
  }
  /** Disposes the prediction maps `release` picks (all by default), and gives their bytes back. */
  release(release: (map: ShadowGenerator) => boolean = () => true): void {
    let released = false;
    for (const [kind, held] of this.held) {
      if (!release(held.generator)) continue;
      this.held.delete(kind);
      held.generator.dispose();
      released = true;
    }
    if (released) this.reserve();
  }
  /** The prediction maps held now. */
  get generators(): readonly ShadowGenerator[] {
    return [...this.held.values()].map((held) => held.generator);
  }
  private predictionBytes(): number {
    let bytes = 0;
    for (const held of this.held.values()) bytes += held.bytes;
    return bytes;
  }
  /** The real maps' reservation, as the last sync made it, with the prediction maps' bytes. */
  reserve(): void {
    reserveSceneShadows(this.scene, { ...this.reserved, bytes: this.reserved.bytes + this.predictionBytes() });
  }
  /**
   * Keeps only the prediction maps built with `currentSettings` (serialized) that fit within `budget` beside the
   * real maps' reservation, in kind order.
   */
  retainWithin(currentSettings: string, budget: number): void {
    let predicted = 0;
    this.release((map) => {
      const held = [...this.held.values()].find((entry) => entry.generator === map)!;
      if (held.key !== currentSettings || this.reserved.bytes + predicted + held.bytes > budget) return true;
      predicted += held.bytes;
      return false;
    });
  }
  /** Disposes every prediction map without reserving: the scene is going. */
  dispose(): void {
    for (const held of this.held.values()) held.generator.dispose();
    this.held.clear();
  }
}

/** Takes `generator` off its light, so receivers never bind it (`light.getShadowGenerator()` does not return it). */
function detachShadowGenerator(generator: ShadowGenerator): void {
  const light = generator.getLight();
  const generators = light._shadowGenerators;
  if (!generators) return;
  for (const [camera, attached] of generators) if (attached === generator) generators.delete(camera);
  if (!generators.size) light._shadowGenerators = null;
}

/** Aims a detached map at `light` (its projection and caster culling) without attaching it. */
function aimShadowGenerator(generator: ShadowGenerator, light: Light): void {
  const target = generator as unknown as {
    _light: Light; _currentRenderId: number; _cachedPosition: Vector3; _cachedDirection: Vector3;
  };
  if (target._light === light) return;
  target._light = light;
  target._currentRenderId = -1;
  target._cachedPosition.setAll(Number.MAX_VALUE);
  target._cachedDirection.setAll(Number.MAX_VALUE);
}
