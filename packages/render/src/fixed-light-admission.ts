import {
  CascadedShadowGenerator,
  DirectionalLight,
  HemisphericLight,
  PointLight,
  RectAreaLight,
  SpotLight,
  type AbstractEngine,
  type Light,
  type Scene,
} from "@babylonjs/core";
import {
  EMPTY_FIXED_LIGHT_INVENTORY,
  FIXED_LIGHT_KINDS,
  effectiveShadowSettings,
  fixedLightDeviceClass,
  fixedLightLayout,
  growFixedLightInventory,
  type FixedLightInventory,
  type FixedLightKind,
  type FixedLightLayout,
} from "@babylonslate/core";
import { hasClusteredLightPolicy } from "./clustered-light-policy";
import {
  assignFixedLightSeats,
  type FixedLightLimit,
  type FixedLightSeat,
  type FixedSeatCandidate,
} from "./fixed-light-seats";
import { forwardLightBudget } from "./forward-light-budget";
import { lightingSamplerCapacity, lightSamplerCost, MATERIAL_SAMPLER_RESERVE } from "./light-sampler-budget";
import {
  isGlobalLight,
  lightsInCreationOrder,
  sortLightsByAdmission,
  type ForwardLightSelection,
} from "./light-policy";
import { sceneRenderingSettings } from "./render-settings";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import { findSceneShadowController } from "./shadow-controller";

/**
 * The seats of a world Scene's fixed light layout and the light in each, as
 * the last lighting sync admitted them. Informational until the shaders bind
 * by seat: lights still reach materials through Babylon's `lightSources`.
 */
export interface FixedLightSlotTable {
  readonly layout: FixedLightLayout;
  /** Every seat in canonical class order. */
  readonly seats: readonly FixedLightSeat<Light>[];
  /** Increases whenever a seat's light or shadow, or the layout, changes. */
  readonly revision: number;
}

type FixedLightingState = {
  /** Inventory high-water mark: it grows during the Scene's life and never shrinks. */
  inventory: FixedLightInventory;
  layoutInputs: string;
  table: FixedLightSlotTable | null;
  slots: number;
  samplerCapacity: number;
  localBudget: number;
  requested: number;
  limited: { light: Light; reason: FixedLightLimit }[];
};

const enabledEngines = new WeakSet<AbstractEngine>();
const worldScenes = new WeakSet<Scene>();
const states = new WeakMap<Scene, FixedLightingState>();

/**
 * Engine-wide switch for fixed-shape forward lighting, off by default. While
 * on, world Scenes admit lights per seat class of a fixed, scene-sized layout
 * instead of ranking them into Babylon's slots. Turning it either way starts
 * every Scene of the Engine from a new inventory.
 */
export function setFixedShapeLightingEnabled(engine: AbstractEngine, enabled: boolean): void {
  if (enabled === enabledEngines.has(engine)) return;
  if (enabled) enabledEngines.add(engine);
  else enabledEngines.delete(engine);
  for (const scene of engine.scenes) {
    states.delete(scene);
    markSceneReadinessDirty(scene);
  }
}

export function isFixedShapeLightingEnabled(engine: AbstractEngine): boolean {
  return enabledEngines.has(engine);
}

/**
 * Marks a world Scene (editor world view, Play, the exported player): only
 * these take fixed-shape lighting. Previews and thumbnails keep the legacy path.
 */
export function setFixedShapeLightingWorldScene(scene: Scene): void {
  worldScenes.add(scene);
}

/** Whether the Scene admits lights through the fixed layout. Clustered Forward keeps the legacy path. */
export function fixedShapeLightingActive(scene: Scene): boolean {
  return worldScenes.has(scene) && enabledEngines.has(scene.getEngine()) && !hasClusteredLightPolicy(scene);
}

/** The Scene's slot table, or null where fixed-shape lighting has not admitted lights. */
export function fixedLightSlotTable(scene: Scene): FixedLightSlotTable | null {
  return fixedShapeLightingActive(scene) ? (states.get(scene)?.table ?? null) : null;
}

/**
 * Samplers a lit Material may bind itself while the Engine uses fixed-shape
 * lighting: a fixed layout can spend all the lighting headroom on every lit
 * draw, which leaves the material reserve. Null while the switch is off.
 */
export function fixedShapeMaterialSamplerBudget(engine: AbstractEngine): number | null {
  if (!enabledEngines.has(engine)) return null;
  return Math.min(engine.getCaps().maxTexturesImageUnits, MATERIAL_SAMPLER_RESERVE);
}

function fixedLightKind(light: Light): FixedLightKind | null {
  if (light instanceof DirectionalLight) return "directional";
  if (light instanceof HemisphericLight) return "hemispheric";
  if (light instanceof SpotLight) return "spot";
  if (light instanceof PointLight) return "point";
  if (light instanceof RectAreaLight) return "area";
  return null;
}

type MutableInventory = Record<FixedLightKind, { lights: number; shadowCasters: number; textured: number }>;
const scratchInventory = Object.fromEntries(
  FIXED_LIGHT_KINDS.map((kind) => [kind, { lights: 0, shadowCasters: 0, textured: 0 }]),
) as MutableInventory;

/** Every light of the Scene, enabled or not; shadow casters count only while scene shadows are on. */
function measureInventory(scene: Scene, shadowsOn: boolean): FixedLightInventory {
  for (const kind of FIXED_LIGHT_KINDS) {
    const count = scratchInventory[kind];
    count.lights = count.shadowCasters = count.textured = 0;
  }
  const controller = shadowsOn ? findSceneShadowController(scene) : undefined;
  for (const light of scene.lights) {
    const kind = fixedLightKind(light);
    if (!kind) continue;
    const count = scratchInventory[kind];
    count.lights++;
    if (controller?.requestsShadow(light)) count.shadowCasters++;
    if (light instanceof RectAreaLight && light.emissionTexture) count.textured++;
  }
  return scratchInventory;
}

function sameSeats(a: readonly FixedLightSeat<Light>[], b: readonly FixedLightSeat<Light>[]): boolean {
  return (
    a.length === b.length &&
    a.every((seat, index) => {
      const other = b[index]!;
      return seat.classId === other.classId && seat.light === other.light && seat.shadowActive === other.shadowActive;
    })
  );
}

/**
 * Per-class admission, the `syncForwardLightPolicy` selection while
 * fixed-shape lighting is active. Ranks the candidates as the legacy budget
 * does (sun and fill, priority, camera distance with the incumbent bonus,
 * identity), admits them while a seat of their kind remains, then seats them
 * (`assignFixedLightSeats`). A light holds a shadow map when the Scene's
 * shadow controller admitted one for it at its last sync.
 */
export const selectFixedShapeLights: ForwardLightSelection = (
  scene,
  candidates,
  previous,
  capacity,
  limited,
  samplerLimited,
) => {
  let state = states.get(scene);
  if (!state) {
    state = {
      inventory: EMPTY_FIXED_LIGHT_INVENTORY,
      layoutInputs: "",
      table: null,
      slots: 0,
      samplerCapacity: 0,
      localBudget: 0,
      requested: 0,
      limited: [],
    };
    states.set(scene, state);
  }
  const engine = scene.getEngine();
  const rendering = sceneRenderingSettings(scene);
  const { settings: shadows } = effectiveShadowSettings(
    rendering.shadows,
    engine._features.supportCSM && CascadedShadowGenerator.IsSupported,
    rendering.mode,
  );
  const inventory = growFixedLightInventory(
    state.inventory,
    measureInventory(scene, shadows.enabled && scene.shadowsEnabled),
  );
  const budget = forwardLightBudget(engine);
  const device = fixedLightDeviceClass({ webgpu: budget.source === "webgpu", slots: budget.slots });
  const layoutInputs = [device, capacity.lights, capacity.samplers, shadows.filter, shadows.cascades, shadows.maxLocalLights].join();
  let layout = state.table?.layout;
  if (!layout || inventory !== state.inventory || layoutInputs !== state.layoutInputs) {
    const next = fixedLightLayout({ device, slots: capacity.lights, samplers: capacity.samplers, shadows, inventory });
    // An input change that leaves the layout as it was keeps its identity.
    if (!layout || next.key !== layout.key || next.trims.join() !== layout.trims.join()) layout = next;
  }
  state.inventory = inventory;
  state.layoutInputs = layoutInputs;
  state.slots = capacity.lights;
  state.samplerCapacity = capacity.samplers;
  state.localBudget = capacity.locals;

  sortLightsByAdmission(scene, candidates, previous);
  const controller = findSceneShadowController(scene);
  const ranked: FixedSeatCandidate<Light>[] = [];
  const unseatable: Light[] = [];
  for (const light of candidates) {
    const kind = fixedLightKind(light);
    if (!kind) {
      unseatable.push(light);
      continue;
    }
    const map = (kind === "directional" || kind === "spot" || kind === "point") && controller?.generator(light) ? kind : null;
    ranked.push({ light, kind, map, local: !isGlobalLight(light) });
  }
  let samplers = 0;
  let hasArea = false;
  const assignment = assignFixedLightSeats(layout, ranked, state.table?.seats ?? [], {
    maxLights: capacity.lights,
    localBudget: capacity.locals,
    // The bound textures' samplers (area tables and emission) still follow the admitted lights.
    accept: ({ light }) => {
      const cost = lightSamplerCost(scene, light, hasArea);
      if (samplers + cost > capacity.samplers) return false;
      samplers += cost;
      hasArea ||= light instanceof RectAreaLight;
      return true;
    },
  });
  state.limited = [
    ...assignment.limited,
    ...unseatable.map((light) => ({ light, reason: "seats" as const })),
  ];
  for (const { light, reason } of state.limited) {
    limited.push(light);
    if (reason === "samplers") samplerLimited.push(light);
  }
  state.requested = candidates.length;
  const table = state.table;
  if (!table || table.layout !== layout || !sameSeats(table.seats, assignment.seats))
    state.table = { layout, seats: assignment.seats, revision: (table?.revision ?? 0) + 1 };
  return { admitted: assignment.admitted, samplers };
};

const LIMIT_LABELS: Record<FixedLightLimit, string> = {
  seats: "no free seat",
  localBudget: "scalability local lights",
  samplers: "sampler headroom",
};

/** The fixed layout and the lights it left out, for render diagnostics; empty when nothing is limited or trimmed. */
export function fixedShapeLightingLimits(scene: Scene): string[] {
  const state = states.get(scene);
  const layout = state?.table?.layout;
  if (!state || !layout || !fixedShapeLightingActive(scene)) return [];
  if (!state.limited.length && !layout.trims.length) return [];
  const classes = layout.classes
    .map((entry) => `${entry.id} ${entry.seats}${entry.shadow ? " shadowed" : ""}${entry.textured ? " textured" : ""}`)
    .join(", ");
  const reasons = new Map(state.limited.map(({ light, reason }) => [light, reason]));
  const names = lightsInCreationOrder([...reasons.keys()]).slice(0, 16)
    .map((light) => `${light.name} (${LIMIT_LABELS[reasons.get(light)!]})`)
    .join(", ");
  return [
    `Fixed-shape lighting: ${state.requested - state.limited.length}/${state.requested} requested lights admitted; ` +
      `layout ${classes} (${layout.seats} seats of ${state.slots} slots, ${layout.device}); ` +
      `${layout.samplers}/${state.samplerCapacity} lighting samplers; ${state.localBudget} scalability local lights.` +
      (layout.trims.length ? ` Trimmed: ${layout.trims.join("; ")}.` : "") +
      (names ? ` Limited: ${names}${reasons.size > 16 ? ", …" : ""}` : ""),
  ];
}
