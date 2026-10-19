import {
  Color3,
  DirectionalLight,
  HemisphericLight,
  Light,
  PBRMaterialDefines,
  PointLight,
  PrepareDefinesForLight,
  RectAreaLight,
  SpotLight,
  StandardMaterialDefines,
  UniformBuffer,
  type AbstractEngine,
  type AbstractMesh,
  type Effect,
  type MaterialDefines,
  type Scene,
} from "@babylonjs/core";
import type { FixedLightKind, FixedLightLayout } from "@babylonslate/core";
import type { FixedLightSeat } from "./fixed-light-seats";
import { markSceneReadinessDirty } from "./scene-readiness-signal";

/**
 * Fixed-shape light binding: native PBR and Standard materials of a world
 * Scene compile one shader per fixed light layout and bind lights by seat.
 *
 * Babylon's material helpers set a receiver's light defines and bind its
 * lights from `mesh.lightSources`, one shader index per light. The patched
 * helpers (`PrepareDefinesForLights`, `BindLights`, `AreLightsTexturesReady`)
 * first ask `scene._materialLightHooks`, which this module installs:
 *
 * - Seat j of the layout is shader light j. Its light code depends on its
 *   class alone (the class's one light kind, default falloff). It is active
 *   while `light{j}.vLightDiffuse.a` is not negative: Babylon writes a light's
 *   range there on every bind, and an empty seat binds a per-kind null buffer
 *   holding -1 (`fixed-light-shader.ts` turns that into a multiplier or a
 *   branch, `setFixedShapeLightGuard`). A light switching on or off, or moving
 *   to another seat of its class, changes bindings only.
 * - Shadow sampling and area seats still follow their light: a seat of a
 *   shadowed class samples its light's map only while that light's shadow is
 *   active there (the map's defines, as Babylon sets them), and area seats are
 *   prepared and bound as Babylon does, packed in seat order. Both recompile
 *   when they change, as on the legacy path.
 *
 * Node materials and the CEL adapter keep Babylon's path: their shaders use
 * other light includes.
 */

/** The slot table a Scene's hooks bind from; null keeps Babylon's light path. */
export type FixedLightTableSource = () => {
  readonly layout: FixedLightLayout;
  readonly seats: readonly FixedLightSeat<Light>[];
} | null;

type MaterialLightHooks = {
  prepareDefinesForLights(
    scene: Scene,
    mesh: AbstractMesh,
    defines: MaterialDefines & Record<string, unknown>,
    specularSupported: boolean,
    maxSimultaneousLights: number,
    disableLighting: boolean,
  ): boolean | undefined;
  bindLights(
    scene: Scene,
    mesh: AbstractMesh,
    effect: Effect,
    defines: (MaterialDefines & Record<string, unknown>) | boolean,
    maxSimultaneousLights: number,
  ): boolean;
  areLightsTexturesReady(scene: Scene, mesh: AbstractMesh, maxSimultaneousLights: number): boolean | undefined;
};

type HookedScene = Scene & { _materialLightHooks?: MaterialLightHooks };

/** Babylon binds 32 lights at most; names are built once. */
const MAX_SEATS = 32;
const names = (prefix: string) => Array.from({ length: MAX_SEATS }, (_, index) => `${prefix}${index}`);
const LIGHT = names("LIGHT");
const SEAT = names("SLATE_FIXED_LIGHT");
const LIGHT_BLOCK = names("Light");
/** Per-light define families Babylon resets for indices past the last light (`PrepareDefinesForLights`). */
const RESET_FAMILIES = [
  "LIGHT", "HEMILIGHT", "POINTLIGHT", "DIRLIGHT", "SPOTLIGHT", "AREALIGHT", "CLUSTLIGHT", "SHADOW", "SHADOWCSM",
  "SHADOWCSMDEBUG", "SHADOWCSMNUM_CASCADES", "SHADOWCSMUSESHADOWMAXZ", "SHADOWCSMNOBLEND", "SHADOWCSM_RIGHTHANDED",
  "SHADOWPCF", "SHADOWPCSS", "SHADOWPOISSON", "SHADOWESM", "SHADOWCLOSEESM", "SHADOWCUBE", "SHADOWLOWQUALITY",
  "SHADOWMEDIUMQUALITY", "SLATE_FIXED_LIGHT",
].map(names);

const LIGHT_CLASSES = {
  directional: DirectionalLight,
  hemispheric: HemisphericLight,
  spot: SpotLight,
  point: PointLight,
  area: RectAreaLight,
} as const satisfies Record<FixedLightKind, unknown>;

const KIND_DEFINES = {
  directional: "DIRLIGHT",
  hemispheric: "HEMILIGHT",
  spot: "SPOTLIGHT",
  point: "POINTLIGHT",
  area: "AREALIGHT",
} as const satisfies Record<FixedLightKind, string>;

/**
 * The light every unshadowed seat of a kind is prepared with: its kind's own
 * light-specific defines, default falloff and lightmap mode, white specular
 * and no shadow, so the seat's defines never depend on the light seated there.
 */
function seatLight(kind: Exclude<FixedLightKind, "area">): Light {
  const proxy = {
    falloffType: Light.FALLOFF_DEFAULT,
    lightmapMode: Light.LIGHTMAP_DEFAULT,
    specular: Color3.White(),
    shadowEnabled: false,
    // Read by SpotLight's light-specific defines: no projection or IES texture.
    projectionTexture: null,
    _iesProfileTexture: null,
    prepareLightSpecificDefines(defines: MaterialDefines, index: number) {
      LIGHT_CLASSES[kind].prototype.prepareLightSpecificDefines.call(proxy as unknown as Light, defines, index);
    },
  };
  return proxy as unknown as Light;
}
const SEAT_LIGHTS = {
  directional: seatLight("directional"),
  hemispheric: seatLight("hemispheric"),
  spot: seatLight("spot"),
  point: seatLight("point"),
};

/** Whether Babylon would list the light in the mesh's `lightSources`. */
function reaches(light: Light, mesh: AbstractMesh): boolean {
  return light.isEnabled() && light.canAffectMesh(mesh);
}

/** The one light kind a layout class compiles; classes host one kind each. */
function classKind(hosts: readonly FixedLightKind[]): FixedLightKind {
  if (hosts.length !== 1) throw new Error(`Fixed light seats compile one light kind per class, not ${hosts.join("/")}.`);
  return hosts[0]!;
}

let legacyScopes = 0;

/** Runs `prepare` with Babylon's own light defines in every Scene (materials whose shaders use other light includes). */
export function withLegacyLightDefines<T>(prepare: () => T): T {
  legacyScopes++;
  try {
    return prepare();
  } finally {
    legacyScopes--;
  }
}

type Defines = MaterialDefines & Record<string, unknown>;

function setDefine(defines: Defines, name: string, value: boolean | number, state: { needRebuild: boolean }): void {
  if (defines[name] === undefined) state.needRebuild = true;
  defines[name] = value;
}

/** Leaves no seat define behind when Babylon's path takes over, so its defines text is Babylon's own. */
function clearSeatDefines(defines: Defines): void {
  if (!defines.SLATE_FIXED_LIGHTS) return;
  defines.SLATE_FIXED_LIGHTS = false;
  defines.SLATE_FIXED_LIGHT_BRANCH = false;
  for (const name of SEAT) if (defines[name] !== undefined) defines[name] = false;
}

function seatsByClass(layout: FixedLightLayout) {
  return layout.classes.filter((entry) => entry.seats > 0).map((entry) => ({ entry, kind: classKind(entry.hosts) }));
}

function prepareSeatDefines(
  scene: Scene,
  mesh: AbstractMesh,
  defines: Defines,
  specularSupported: boolean,
  maxSimultaneousLights: number,
  table: NonNullable<ReturnType<FixedLightTableSource>>,
): boolean {
  const state = {
    needNormals: defines._needNormals,
    needRebuild: false,
    lightmapMode: false,
    shadowEnabled: false,
    specularEnabled: false,
  };
  let index = 0;
  let seat = 0;
  for (const { entry, kind } of seatsByClass(table.layout)) {
    for (let classSeat = 0; classSeat < entry.seats; classSeat++, seat++) {
      const { light, shadowActive } = table.seats[seat]!;
      if (kind === "area") {
        // Area seats keep Babylon's per-light defines, packed in seat order.
        if (!light || !reaches(light, mesh)) continue;
        PrepareDefinesForLight(scene, mesh, light, index, defines, specularSupported, state);
        setDefine(defines, SEAT[index]!, false, state);
        index++;
        continue;
      }
      // A seat samples a map only for the light whose shadow is active there.
      const shadowed = entry.shadow !== null && shadowActive && !!light && reaches(light, mesh);
      PrepareDefinesForLight(
        scene,
        (shadowed ? mesh : null) as AbstractMesh,
        shadowed ? light : SEAT_LIGHTS[kind],
        index,
        defines,
        specularSupported,
        state,
      );
      setDefine(defines, SEAT[index]!, true, state);
      index++;
    }
  }
  defines.SPECULARTERM = state.specularEnabled;
  defines.SHADOWS = state.shadowEnabled;
  const reset = Math.max(maxSimultaneousLights, Number(defines.MAXLIGHTCOUNT) || 0, table.layout.seats);
  for (let unused = index; unused < Math.min(reset, MAX_SEATS); unused++) {
    if (defines[LIGHT[unused]!] === undefined) continue;
    for (const family of RESET_FAMILIES) defines[family[unused]!] = false;
  }
  defines.LIGHTCOUNT = index;
  defines.MAXLIGHTCOUNT = table.layout.seats;
  const caps = scene.getEngine().getCaps();
  if (defines.SHADOWFLOAT === undefined) state.needRebuild = true;
  defines.SHADOWFLOAT =
    state.shadowEnabled &&
    ((caps.textureFloatRender && caps.textureFloatLinearFiltering) ||
      (caps.textureHalfFloatRender && caps.textureHalfFloatLinearFiltering));
  defines.LIGHTMAPEXCLUDED = state.lightmapMode;
  setDefine(defines, "SLATE_FIXED_LIGHT_BRANCH", fixedShapeLightGuard(scene.getEngine()) === "branch", state);
  setDefine(defines, "SLATE_FIXED_LIGHTS", true, state);
  if (state.needRebuild) defines.rebuild();
  return state.needNormals;
}

/** The seats an Effect was compiled with, from its defines: null for an Effect on Babylon's path. */
type EffectSeats = { kinds: (FixedLightKind | null)[]; fixed: boolean[]; shadowed: boolean[] };

const effectSeatCache = new WeakMap<Effect, { defines: string; seats: EffectSeats | null }>();

export function effectLightSeats(effect: Effect): EffectSeats | null {
  const cached = effectSeatCache.get(effect);
  if (cached?.defines === effect.defines) return cached.seats;
  const lines = new Set(effect.defines.split("\n"));
  let seats: EffectSeats | null = null;
  if (lines.has("#define SLATE_FIXED_LIGHTS")) {
    seats = { kinds: [], fixed: [], shadowed: [] };
    for (let index = 0; index < MAX_SEATS && lines.has(`#define ${LIGHT[index]}`); index++) {
      const kind = (Object.keys(KIND_DEFINES) as FixedLightKind[]).find((entry) =>
        lines.has(`#define ${KIND_DEFINES[entry]}${index}`)) ?? null;
      seats.kinds.push(kind);
      seats.fixed.push(lines.has(`#define ${SEAT[index]}`));
      seats.shadowed.push(lines.has(`#define SHADOW${index}`));
    }
  }
  effectSeatCache.set(effect, { defines: effect.defines, seats });
  return seats;
}

const emptySeatBuffers = new WeakMap<AbstractEngine, Map<FixedLightKind, UniformBuffer>>();

/**
 * One buffer per light kind and Engine for empty seats: the kind's own uniform
 * layout, so the seat's block is backed on WebGL2 and WebGPU, with the range
 * the seat tests set to -1.
 */
export function emptyLightSeatBuffer(engine: AbstractEngine, kind: FixedLightKind): UniformBuffer {
  let buffers = emptySeatBuffers.get(engine);
  if (!buffers) {
    const owned = (buffers = new Map());
    emptySeatBuffers.set(engine, owned);
    engine.onDisposeObservable.addOnce(() => {
      for (const buffer of owned.values()) buffer.dispose();
      owned.clear();
    });
  }
  let buffer = buffers.get(kind);
  if (!buffer) {
    buffer = new UniformBuffer(engine, undefined, false, `slateEmptyLightSeat:${kind}`);
    const layout = LIGHT_CLASSES[kind].prototype as unknown as { _buildUniformLayout(this: { _uniformBuffer: UniformBuffer }): void };
    layout._buildUniformLayout.call({ _uniformBuffer: buffer });
    // Black, range -1 (inactive). The rest is a finite light far overhead, for multiplied guards that still evaluate it.
    buffer.updateFloat4("vLightDiffuse", 0, 0, 0, -1);
    buffer.updateFloat4("vLightSpecular", 0, 0, 0, 0);
    if (kind === "directional") buffer.updateFloat4("vLightData", 0, -1, 0, 1);
    else if (kind === "hemispheric") buffer.updateFloat4("vLightData", 0, 1, 0, 0);
    else if (kind === "point" || kind === "spot") {
      buffer.updateFloat4("vLightData", 0, EMPTY_SEAT_HEIGHT, 0, kind === "spot" ? 1 : 0);
      buffer.updateFloat4("vLightFalloff", EMPTY_SEAT_HEIGHT, 1 / (EMPTY_SEAT_HEIGHT * EMPTY_SEAT_HEIGHT), 1, 0);
      if (kind === "spot") buffer.updateFloat4("vLightDirection", 0, -1, 0, 0.5);
    }
    buffer.update();
    buffers.set(kind, buffer);
  }
  return buffer;
}

/** Height of the empty seats' stand-in point and spot lights, so no surface sits on them. */
const EMPTY_SEAT_HEIGHT = 1e4;

export type FixedLightGuard = "branch" | "multiply";

const guards = new WeakMap<AbstractEngine, FixedLightGuard>();

/**
 * How fixed seats skip an empty seat, a compile-time choice per Engine:
 * "multiply" (default) evaluates every seat without a branch and scales its
 * contribution by the active flag; "branch" runs each seat behind a uniform
 * branch. A change recompiles the seated materials once.
 */
export function setFixedShapeLightGuard(engine: AbstractEngine, guard: FixedLightGuard): void {
  if (fixedShapeLightGuard(engine) === guard) return;
  if (guard === "multiply") guards.delete(engine);
  else guards.set(engine, guard);
  for (const scene of engine.scenes) markSceneReadinessDirty(scene);
}

export function fixedShapeLightGuard(engine: AbstractEngine): FixedLightGuard {
  return guards.get(engine) ?? "multiply";
}

function bindSeats(
  scene: Scene,
  mesh: AbstractMesh,
  effect: Effect,
  defines: Defines | boolean,
  seats: EffectSeats,
  table: ReturnType<FixedLightTableSource>,
): void {
  const useSpecular = typeof defines === "boolean" ? defines : !!defines.SPECULARTERM;
  const tableSeats = table?.seats ?? [];
  const tableKinds = table ? seatKinds(table.layout) : [];
  let area = tableKinds.indexOf("area");
  for (let index = 0; index < seats.kinds.length; index++) {
    const kind = seats.kinds[index];
    if (!kind) continue;
    let light: Light | null = null;
    if (seats.fixed[index]) {
      const seat = tableSeats[index];
      if (seat?.light && tableKinds[index] === kind && reaches(seat.light, mesh)) light = seat.light;
    } else if (kind === "area") {
      // Packed as `prepareSeatDefines` packed them: the next area light that reaches the mesh.
      while (area >= 0 && area < tableSeats.length && !light) {
        const candidate = tableKinds[area] === "area" ? tableSeats[area]!.light : null;
        area++;
        if (candidate && reaches(candidate, mesh)) light = candidate;
      }
    }
    if (light) light._bindLight(index, scene, effect, useSpecular, seats.shadowed[index]! && mesh.receiveShadows);
    else {
      const empty = emptyLightSeatBuffer(scene.getEngine(), kind).getBuffer();
      if (empty) effect.bindUniformBuffer(empty, LIGHT_BLOCK[index]!);
    }
  }
}

const seatKindCache = new WeakMap<FixedLightLayout, FixedLightKind[]>();

function seatKinds(layout: FixedLightLayout): FixedLightKind[] {
  let kinds = seatKindCache.get(layout);
  if (!kinds) {
    kinds = seatsByClass(layout).flatMap(({ entry, kind }) => Array<FixedLightKind>(entry.seats).fill(kind));
    seatKindCache.set(layout, kinds);
  }
  return kinds;
}

/**
 * Appends to `out` everything seated materials' light defines depend on: the
 * layout, the guard, and the light, shadow and textures of shadowed and area
 * seats. Lights moving through unshadowed seats change none of it.
 */
export function fixedLightDefinesSignature(
  scene: Scene,
  table: NonNullable<ReturnType<FixedLightTableSource>>,
  out: unknown[],
): void {
  out.push(table.layout, fixedShapeLightGuard(scene.getEngine()));
  let seat = 0;
  for (const { entry, kind } of seatsByClass(table.layout)) {
    for (let classSeat = 0; classSeat < entry.seats; classSeat++, seat++) {
      if (kind !== "area" && entry.shadow === null) continue;
      const { light, shadowActive } = table.seats[seat]!;
      out.push(
        light,
        shadowActive,
        light?.isEnabled() ?? false,
        light ? (light.getShadowGenerator(scene.activeCamera) ?? light.getShadowGenerator()) : null,
        light instanceof RectAreaLight ? light.emissionTexture : null,
        light instanceof RectAreaLight ? (light.emissionTexture?.isReady() ?? false) : false,
      );
    }
  }
}

/** Native lit materials whose shaders read Babylon's stock light include, on an Engine with uniform buffers. */
function bindsBySeat(scene: Scene, defines: Defines): boolean {
  return (
    legacyScopes === 0 &&
    scene.getEngine().supportsUniformBuffers &&
    (defines instanceof PBRMaterialDefines || defines instanceof StandardMaterialDefines)
  );
}

/**
 * Installs the seat hooks on a Scene. `table` returns the Scene's slot table
 * while fixed-shape lighting is active and null otherwise; with null every
 * material keeps Babylon's light path (and its defines text) unchanged.
 */
export function installFixedLightBinding(scene: Scene, table: FixedLightTableSource): void {
  const hooks: MaterialLightHooks = {
    prepareDefinesForLights(_scene, mesh, defines, specularSupported, maxSimultaneousLights, disableLighting) {
      const current = table();
      if (!current || disableLighting || !scene.lightsEnabled || !bindsBySeat(scene, defines)) {
        clearSeatDefines(defines);
        return undefined;
      }
      return prepareSeatDefines(scene, mesh, defines, specularSupported, maxSimultaneousLights, current);
    },
    bindLights(_scene, mesh, effect, defines) {
      const seats = effectLightSeats(effect);
      if (!seats) return false;
      bindSeats(scene, mesh, effect, defines, seats, table());
      return true;
    },
    areLightsTexturesReady(_scene, mesh) {
      // Seated lights' textures too (Babylon then checks the mesh's lightSources).
      for (const seat of table()?.seats ?? [])
        if (seat.light && reaches(seat.light, mesh) && !seat.light.areLightTexturesReady()) return false;
      return undefined;
    },
  };
  (scene as HookedScene)._materialLightHooks = hooks;
}
