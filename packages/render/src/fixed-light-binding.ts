import {
  CascadedShadowGenerator,
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
  type BaseTexture,
  type Effect,
  type MaterialDefines,
  type Scene,
  type ShadowGenerator,
} from "@babylonjs/core";
import type { FixedLightKind, FixedLightLayout } from "@haptic/core";
import { hasClusteredLightPolicy } from "./clustered-light-policy";
import type { FixedLightSeat } from "./fixed-light-seats";
import { markSceneReadinessDirty } from "./scene-readiness-signal";
import {
  existingShadowSamplerPlaceholders,
  shadowSamplerPlaceholders,
  type ShadowSamplerPlaceholders,
} from "./shadow-sampler-placeholders";

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
 *
 * The same hooks bind a Babylon-path Effect that no longer matches its mesh's
 * lights: a Material drawing its previous Effect while a changed variant
 * compiles (a variant swap, `variant-swaps.ts`). See `bindsLikeBabylon`.
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

/**
 * Whether Babylon would list the light in the mesh's `lightSources`. A light
 * disposed after the frame's lighting sync is still seated until the next one.
 */
function reaches(light: Light, mesh: AbstractMesh): boolean {
  return !light.isDisposed() && light.isEnabled() && light.canAffectMesh(mesh);
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

const classesWithSeats = new WeakMap<FixedLightLayout, { entry: FixedLightLayout["classes"][number]; kind: FixedLightKind }[]>();

/** The layout's classes that have seats, with the light kind each compiles (cached: it runs per material light refresh). */
function seatsByClass(layout: FixedLightLayout) {
  let classes = classesWithSeats.get(layout);
  if (!classes) {
    classes = layout.classes.filter((entry) => entry.seats > 0).map((entry) => ({ entry, kind: classKind(entry.hosts) }));
    classesWithSeats.set(layout, classes);
  }
  return classes;
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
    // Only keys that exist: a key added here would miss the defines text when a later seat sets it.
    for (const family of RESET_FAMILIES) if (defines[family[unused]!] !== undefined) defines[family[unused]!] = false;
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
    } else if (kind === "area") {
      // A small quad far overhead: the area integral stays finite, and black light scales it to zero.
      buffer.updateFloat4("vLightData", 0, EMPTY_SEAT_HEIGHT, 0, 0);
      buffer.updateFloat4("vLightWidth", 0.5, 0, 0, 0);
      buffer.updateFloat4("vLightHeight", 0, 0, 0.5, 0);
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
    bindLights(_scene, mesh, effect, defines, maxSimultaneousLights) {
      const seats = effectLightSeats(effect);
      if (seats) {
        bindSeats(scene, mesh, effect, defines, seats, table());
        return true;
      }
      const lights = compiledLights(effect);
      if (!lights || !scene.getEngine().supportsUniformBuffers || bindsLikeBabylon(scene, mesh, lights, maxSimultaneousLights))
        return false;
      bindCompiledLights(scene, mesh, effect, lights, typeof defines === "boolean" ? defines : !!defines.SPECULARTERM);
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
  hookedScenes.add(scene);
}

const hookedScenes = new WeakSet<Scene>();

/**
 * Whether a world view may draw a Material's previous Effect while its changed variant compiles: the Scene binds such
 * an Effect by its own light layout (these hooks), on an Engine with uniform buffers, outside Clustered Forward (whose
 * cluster bindings follow the current lights).
 */
export function sceneBindsPreviousEffects(scene: Scene): boolean {
  return hookedScenes.has(scene) && scene.getEngine().supportsUniformBuffers && !hasClusteredLightPolicy(scene);
}

/**
 * Allocates what a previous Effect's bindings may need (the sampler placeholders) before a frame's passes: a render
 * target allocated inside a pass would rebind the framebuffer it draws to.
 */
export function preparePreviousEffectBindings(scene: Scene): void {
  if (!scene.isDisposed) shadowSamplerPlaceholders(scene);
}

/** Light textures a shader light samples, as flags. */
const PROJECTION = 1;
const IES = 2;
const EMISSION = 4;

type ShadowSampling = { readonly cube: boolean; readonly cascades: boolean; readonly pcf: boolean; readonly pcss: boolean };

/** A Babylon-path Effect's lights as compiled: per shader light, its Babylon type id, shadow sampling and textures. */
type CompiledLights = {
  readonly types: readonly number[];
  readonly shadows: readonly (ShadowSampling | null)[];
  readonly textures: readonly number[];
};

/** `Light.LIGHTTYPEID_*` by kind, and back. */
const TYPE_IDS = { point: 0, directional: 1, spot: 2, hemispheric: 3, area: 4 } as const satisfies Record<FixedLightKind, number>;
const KIND_BY_TYPE: readonly FixedLightKind[] = ["point", "directional", "spot", "hemispheric", "area"];
const AREA_TYPE = TYPE_IDS.area;
const SHADOW_TEXTURE = names("shadowTexture");
const DEPTH_TEXTURE = names("depthTexture");
const PROJECTION_TEXTURE = names("projectionLightTexture");
const IES_TEXTURE = names("iesLightTexture");
const EMISSION_TEXTURE = names("rectAreaLightEmissionTexture");

const compiledLightsCache = new WeakMap<Effect, { defines: string; lights: CompiledLights | null }>();

/** Parsed once per Effect: null for a seat-bound or unlit Effect, or one with a light kind no stand-in exists for. */
function compiledLights(effect: Effect): CompiledLights | null {
  const cached = compiledLightsCache.get(effect);
  if (cached?.defines === effect.defines) return cached.lights;
  const lines = new Set(effect.defines.split("\n"));
  let lights: CompiledLights | null = null;
  if (!lines.has("#define SLATE_FIXED_LIGHTS") && lines.has(`#define ${LIGHT[0]}`)) {
    const types: number[] = [];
    const shadows: (ShadowSampling | null)[] = [];
    const textures: number[] = [];
    for (let index = 0; index < MAX_SEATS && lines.has(`#define ${LIGHT[index]}`); index++) {
      const kind = (Object.keys(KIND_DEFINES) as FixedLightKind[]).find((entry) => lines.has(`#define ${KIND_DEFINES[entry]}${index}`));
      types.push(kind ? TYPE_IDS[kind] : -1);
      shadows.push(lines.has(`#define SHADOW${index}`)
        ? {
          cube: lines.has(`#define SHADOWCUBE${index}`),
          cascades: lines.has(`#define SHADOWCSM${index}`),
          pcf: lines.has(`#define SHADOWPCF${index}`),
          pcss: lines.has(`#define SHADOWPCSS${index}`),
        }
        : null);
      textures.push(
        (lines.has(`#define PROJECTEDLIGHTTEXTURE${index}`) ? PROJECTION : 0) |
        (lines.has(`#define IESLIGHTTEXTURE${index}`) ? IES : 0) |
        (lines.has(`#define RECTAREALIGHTEMISSIONTEXTURE${index}`) ? EMISSION : 0),
      );
    }
    // A clustered container (or any kind without a stand-in) stays on Babylon's own binding.
    if (!types.includes(-1)) lights = { types, shadows, textures };
  }
  compiledLightsCache.set(effect, { defines: effect.defines, lights });
  return lights;
}

/** The light binds the shadow map `sampling` reads, as Babylon's `_bindLight` would bind it here. */
function shadowMatches(scene: Scene, mesh: AbstractMesh, light: Light, sampling: ShadowSampling): boolean {
  if (!mesh.receiveShadows || !scene.shadowsEnabled || !light.shadowEnabled) return false;
  const generator = (light.getShadowGenerator(scene.activeCamera) ?? light.getShadowGenerator()) as ShadowGenerator | null;
  if (!generator?.getShadowMap()) return false;
  // Only point lights render cube maps.
  return (light.getTypeID() === TYPE_IDS.point) === sampling.cube &&
    generator instanceof CascadedShadowGenerator === sampling.cascades &&
    generator.usePercentageCloserFiltering === sampling.pcf &&
    generator.useContactHardeningShadow === sampling.pcss;
}

/** The light binds every light texture `flags` reads (`transferTexturesToEffect` binds only ready ones). */
function texturesMatch(light: Light, flags: number): boolean {
  if (flags & (PROJECTION | IES)) {
    if (!(light instanceof SpotLight)) return false;
    if (flags & PROJECTION && !light.projectionTexture?.isReady()) return false;
    if (flags & IES && !(light as unknown as { _iesProfileTexture: BaseTexture | null })._iesProfileTexture?.isReady()) return false;
  }
  if (flags & EMISSION && !(light instanceof RectAreaLight &&
    (light as unknown as { _emissionTextureTexture: BaseTexture | null })._emissionTextureTexture?.isReady())) return false;
  return true;
}

/**
 * Whether Babylon's `BindLights` binds `effect` correctly for `mesh`: the first lights it binds (`lightSources`, up to
 * `maxSimultaneousLights`) are of the Effect's kinds in order, and bind every shadow map and light texture it samples.
 * That holds whenever the Effect was built from the mesh's current lights. A previous Effect (a variant swap) can
 * differ: Light blocks differ in size by kind, so another kind's buffer is an INVALID_OPERATION on WebGL2 and a
 * validation error on WebGPU, and a sampler left without its map keeps whatever texture its unit last held.
 */
function bindsLikeBabylon(scene: Scene, mesh: AbstractMesh, lights: CompiledLights, maxSimultaneousLights: number): boolean {
  const sources = mesh.lightSources;
  if (Math.min(sources.length, maxSimultaneousLights) < lights.types.length) return false;
  for (let index = 0; index < lights.types.length; index++) {
    const light = sources[index]!;
    if (light.getTypeID() !== lights.types[index]) return false;
    const sampling = lights.shadows[index];
    if (sampling && !shadowMatches(scene, mesh, light, sampling)) return false;
    const textures = lights.textures[index]!;
    if (textures && !texturesMatch(light, textures)) return false;
  }
  return true;
}

const usedLights = new Set<Light>();

/**
 * Binds a previous Effect by its own light layout: each shader light takes the mesh's light at its index when that
 * light is of its kind, else the next unused light of its kind, else the empty buffer of its kind (black, so it adds
 * nothing). A shadow map or light texture the bound light cannot supply gets a placeholder of the sampler's type.
 */
function bindCompiledLights(scene: Scene, mesh: AbstractMesh, effect: Effect, lights: CompiledLights, useSpecular: boolean): void {
  const engine = scene.getEngine();
  const sources = mesh.lightSources;
  const placeholders = existingShadowSamplerPlaceholders(scene);
  try {
    for (let index = 0; index < lights.types.length; index++) {
      const type = lights.types[index]!;
      let light: Light | undefined = sources[index];
      if (!light || usedLights.has(light) || light.getTypeID() !== type) {
        light = undefined;
        for (const candidate of sources) {
          if (usedLights.has(candidate) || candidate.getTypeID() !== type) continue;
          light = candidate;
          break;
        }
      }
      const sampling = lights.shadows[index];
      const shadowed = !!light && !!sampling && shadowMatches(scene, mesh, light, sampling);
      if (light) {
        usedLights.add(light);
        light._bindLight(index, scene, effect, useSpecular, shadowed);
      } else {
        const empty = emptyLightSeatBuffer(engine, KIND_BY_TYPE[type]!).getBuffer();
        if (empty) effect.bindUniformBuffer(empty, LIGHT_BLOCK[index]!);
      }
      // Without placeholders (a swap no probe saw) a missing map keeps its unit's last texture, as Babylon does.
      if (!placeholders) continue;
      if (sampling && !shadowed) bindShadowPlaceholder(effect, index, sampling, placeholders);
      const textures = lights.textures[index]!;
      if (textures && !(light && texturesMatch(light, textures))) {
        if (textures & PROJECTION) effect.setTexture(PROJECTION_TEXTURE[index]!, placeholders.plain);
        if (textures & IES) effect.setTexture(IES_TEXTURE[index]!, placeholders.plain);
        if (textures & EMISSION) effect.setTexture(EMISSION_TEXTURE[index]!, placeholders.plain);
      }
      // An area light binds the Scene's lookup tables itself; an empty area light leaves them to the placeholders.
      if (type === AREA_TYPE && !light) {
        const tables = (scene as unknown as { _ltcTextures?: { LTC1: BaseTexture; LTC2: BaseTexture } })._ltcTextures;
        effect.setTexture("areaLightsLTC1Sampler", tables?.LTC1 ?? placeholders.plain);
        effect.setTexture("areaLightsLTC2Sampler", tables?.LTC2 ?? placeholders.plain);
      }
    }
  } finally {
    usedLights.clear();
  }
}

function bindShadowPlaceholder(effect: Effect, index: number, sampling: ShadowSampling, placeholders: ShadowSamplerPlaceholders): void {
  const compares = sampling.pcf || sampling.pcss;
  if (sampling.cube) effect.setTexture(SHADOW_TEXTURE[index]!, placeholders.cube);
  else if (sampling.cascades) effect.setTexture(SHADOW_TEXTURE[index]!, compares ? placeholders.cascades : placeholders.plainCascades);
  else effect.setTexture(SHADOW_TEXTURE[index]!, compares ? placeholders.compare : placeholders.plain);
  if (sampling.pcss) effect.setTexture(DEPTH_TEXTURE[index]!, sampling.cascades ? placeholders.plainCascades : placeholders.plain);
}
