import {
  InstancedMesh,
  type AbstractEngine,
  type AbstractMesh,
  type Material,
  type RenderTargetTexture,
  type Scene,
  type ShadowGenerator,
} from "@babylonjs/core";
import { isPipelineWarmupMesh, isRevealPending } from "./reveal-pending";
import { awaitsFirstDraw } from "./shadow-first-draw";
import { chargeWarmMap, warmMapRoom } from "./shadow-map-warm";
import {
  beginPipelineDeferral,
  deferredPipelineCount,
  deferredPipelinesStalled,
  PIPELINE_DEFERRAL_STALL_MS,
  pipelinesDeferred,
  type PipelineDeferral,
} from "./webgpu-pipeline-deferral";

/**
 * WebGPU: casters new to a shadow map that has drawn. Babylon's shadow pass creates a missing render pipeline
 * synchronously at its draw, and a caster whose depth variant or vertex layout no caster of the map drew (a spawn, a
 * mesh revealed or moved into the map's reach, an instanced, skinned or alpha-tested one) misses it. A warm render of
 * the whole map would clear what receivers sample, so the map's own real render handles them instead: each caster's
 * draws sit between Babylon's `onBeforeShadowMapRenderMeshObservable` and `onAfterShadowMapRenderMeshObservable`
 * (which name the level of detail drawn: a caster is its master mesh), and in a world view's steady frame (`active`)
 * the draws of a caster the map has not drawn run inside an isolated deferral scope admitting the map's render
 * passes. A draw whose pipeline exists draws; one whose pipeline is missing is skipped and starts it asynchronously with
 * the map's own target state. Every caster that has drawn into the map draws as before, so the map keeps all it held,
 * and renders once: a new caster whose pipelines exist (a mesh rebuilt every tick, as a script's text is) casts in the
 * frame it arrives, and one still missing some joins once they exist (`casterRedrawDue`), as a caster still compiling
 * does on WebGL2 (a caster of several parts may cast in part meanwhile).
 *
 * A mesh hidden for its reveal (`isRevealPending`) casts into no map. Its colour probe asks each drawn map its reveal
 * would redraw (the controller's `setShadowCasterReach`) for its depth pipelines (`casterPipelinesWarm`): a map that
 * has not listed it since it was hidden is asked to render again (within the frame's warm budget, in any frame), and
 * that render lists it (`listsHiddenCaster`) inside a warm scope only so its draws start them, every one skipped. The
 * reveal waits until they exist, so the mesh appears with its shadow and the redraw its reveal starts creates none. A
 * Play visual rebuilt in place of one that had shown (`replacesDrawnVisual`, a script's text written every tick) asks
 * no map: the slot would otherwise go blank while a map lists it. Revealed, it is a caster new to each map: in a
 * steady frame it casts in that frame's render where its depth pipelines exist and is left out until they do.
 *
 * A caster that has drawn into the map keeps drawing, a later depth variant of its own included (a changed Material
 * whose colour variant is ready, a mesh's first instances), which still creates its pipeline in the draw, since leaving
 * it out would drop a shadow the map holds. Waits end at the deferral's stall: an isolated draw's pipeline compiles
 * synchronously past the Engine's stall or its own, and a reveal waits no longer than `PIPELINE_DEFERRAL_STALL_MS`
 * from the first render that listed the mesh, or from its first ask when no render answers. Pipelines these draws
 * start are charged to the Engine frame's warm budget (`WARM_MAP_PIPELINES_PER_FRAME`), which a real render cannot
 * wait for, so the frame's other warm renders wait instead. A frame that is not a steady one (a strict frame, one that
 * publishes a manual capture) draws every caster the map left out (`leavesOutCasters`), creating its pipelines then.
 */
type Skips = PipelineDeferral[];
/** How a render draws a caster: as before, as one new to the map (isolated), or only to warm (hidden). */
type Kind = "drawn" | "new" | "hidden";

type MapCasters = {
  map: RenderTargetTexture;
  engine: AbstractEngine;
  /** Casters a real draw of the map drew whole. */
  drawn: WeakSet<AbstractMesh>;
  /** Casters new to the map whose last render listing them skipped some draws: the scopes of those draws. */
  leftOut: Map<AbstractMesh, Skips>;
  /**
   * Hidden meshes a render listed since they were hidden (`listsHiddenCaster`): their warm draws' scopes, none when
   * the caster lists left them out, with the Material they had and when the first such render ran.
   */
  warmed: Map<AbstractMesh, { scopes: Skips; material: Material | null; since: number }>;
  /** Hidden meshes whose reveal waits for the map to list them, since when. */
  requests: Map<AbstractMesh, number>;
  /** A tracked render is in progress; `active`: a world view's steady frame's, which isolates new casters. */
  tracking: boolean;
  active: boolean;
  /** This render's casters, how it draws each (a mesh's parts draw alike) and the scopes of draws it skipped. */
  seen: Set<AbstractMesh>;
  decided: Map<AbstractMesh, Kind>;
  skipped: Map<AbstractMesh, Skips>;
  /** The caster draw in progress inside a scope. */
  open: { scope: PipelineDeferral; pendingBefore: number; kind: Kind } | undefined;
};

/** Each tracked generator's bookkeeping, for its current shadow map. */
const maps = new WeakMap<ShadowGenerator, MapCasters>();
const observed = new WeakSet<ShadowGenerator>();
/** The maps holding a record of each mesh, which its disposal clears. */
const recordedIn = new WeakMap<AbstractMesh, Set<MapCasters>>();
/** Each scene's drawn maps a mesh's reveal redraws (`setShadowCasterReach`). */
const reaches = new WeakMap<Scene, (mesh: AbstractMesh, visit: (generator: ShadowGenerator) => void) => void>();

function waits(scopes: Skips): boolean {
  return scopes.some((scope) => scope.waiting());
}

/** The caster Babylon draws `rendering` for: a level of detail draws for its master's entry. */
function casterOf(rendering: AbstractMesh): AbstractMesh {
  return rendering._masterMesh ?? rendering;
}

function record(state: MapCasters, mesh: AbstractMesh): void {
  let owners = recordedIn.get(mesh);
  if (!owners) {
    const own = (owners = new Set());
    recordedIn.set(mesh, own);
    mesh.onDisposeObservable.addOnce(() => {
      for (const owner of own) forget(owner, mesh);
      recordedIn.delete(mesh);
    });
  }
  owners.add(state);
}

function forget(state: MapCasters, mesh: AbstractMesh): void {
  state.leftOut.delete(mesh);
  state.warmed.delete(mesh);
  state.requests.delete(mesh);
}

/** Drops `mesh`'s records in `state` and, once it holds none there, its back reference. */
function drop(state: MapCasters, mesh: AbstractMesh, kinds: { leftOut?: boolean; warmed?: boolean; request?: boolean }): void {
  if (kinds.leftOut) state.leftOut.delete(mesh);
  if (kinds.warmed) state.warmed.delete(mesh);
  if (kinds.request) state.requests.delete(mesh);
  if (!state.leftOut.has(mesh) && !state.warmed.has(mesh) && !state.requests.has(mesh)) recordedIn.get(mesh)?.delete(state);
}

/** A disposed or replaced map forgets every caster, so nothing it recorded outlives it. */
function release(state: MapCasters): void {
  for (const mesh of [...state.leftOut.keys(), ...state.warmed.keys(), ...state.requests.keys()]) recordedIn.get(mesh)?.delete(state);
  state.leftOut.clear();
  state.warmed.clear();
  state.requests.clear();
}

function kindOf(state: MapCasters, mesh: AbstractMesh): Kind {
  let kind = state.decided.get(mesh);
  if (kind === undefined) {
    kind = isRevealPending(mesh) ? "hidden" : state.active && !state.drawn.has(mesh) ? "new" : "drawn";
    state.decided.set(mesh, kind);
  }
  return kind;
}

/** The bookkeeping of `generator`'s current map (a new map starts afresh), its draw observers installed on first use. */
function castersOf(generator: ShadowGenerator): MapCasters | undefined {
  const map = generator.getShadowMap();
  if (!map) return undefined;
  const current = maps.get(generator);
  if (current?.map === map) return current;
  if (current) release(current);
  const state: MapCasters = {
    map, engine: generator.getLight().getScene().getEngine(), drawn: new WeakSet(), leftOut: new Map(), warmed: new Map(),
    requests: new Map(), tracking: false, active: false, seen: new Set(), decided: new Map(), skipped: new Map(),
    open: undefined,
  };
  maps.set(generator, state);
  map.onDisposeObservable.addOnce(() => release(state));
  if (observed.has(generator)) return state;
  observed.add(generator);
  // Only tracked renders count: a first draw's warm render (`shadow-map-warm.ts`) skips every draw itself.
  generator.onBeforeShadowMapRenderMeshObservable.add((rendering) => {
    const own = maps.get(generator);
    if (!own?.tracking) return;
    const mesh = casterOf(rendering);
    own.seen.add(mesh);
    if (own.open) return;
    const kind = kindOf(own, mesh);
    if (kind === "drawn") return;
    const passes = own.map.renderPassIds;
    const pendingBefore = deferredPipelineCount(own.engine);
    const scope = beginPipelineDeferral(own.engine, (pass) => passes.includes(pass), kind === "hidden" ? { warm: true } : { isolated: true });
    if (scope) own.open = { scope, pendingBefore, kind };
  });
  generator.onAfterShadowMapRenderMeshObservable.add((rendering) => {
    const own = maps.get(generator);
    if (!own?.tracking) return;
    const mesh = casterOf(rendering);
    const open = own.open;
    if (!open) {
      if (kindOf(own, mesh) !== "drawn") return;
      own.drawn.add(mesh);
      if (own.leftOut.has(mesh) || own.warmed.has(mesh)) drop(own, mesh, { leftOut: true, warmed: true });
      return;
    }
    own.open = undefined;
    const skipped = open.scope.close();
    chargeWarmMap(own.engine, open.pendingBefore);
    if (open.kind === "new" && !skipped) return;
    let scopes = own.skipped.get(mesh);
    if (!scopes) own.skipped.set(mesh, (scopes = []));
    scopes.push(open.scope);
  });
  return state;
}

/** Records one tracked render. */
function settle(state: MapCasters): void {
  if (state.open) {
    state.open.scope.close();
    chargeWarmMap(state.engine, state.open.pendingBefore);
    state.open = undefined;
  }
  const now = performance.now();
  for (const [mesh, kind] of state.decided) {
    if (kind === "drawn") continue;
    const scopes = state.skipped.get(mesh);
    if (kind === "hidden") {
      const material = mesh.material ?? null;
      const before = state.warmed.get(mesh);
      record(state, mesh);
      state.warmed.set(mesh, { scopes: scopes ?? [], material, since: before?.material === material ? before.since : now });
      state.requests.delete(mesh);
    } else if (scopes) {
      record(state, mesh);
      state.leftOut.set(mesh, scopes);
    } else {
      // A new caster every draw of which found its pipeline has drawn whole.
      state.drawn.add(mesh);
      drop(state, mesh, { leftOut: true, warmed: true });
    }
  }
  // Every tracked render answers the requests: a hidden mesh it did not list has nothing to warm in this map, and a
  // mesh no longer hidden needs nothing.
  for (const mesh of state.requests.keys()) {
    if (!isRevealPending(mesh)) drop(state, mesh, { request: true });
    else if (!state.decided.has(mesh)) {
      state.warmed.set(mesh, { scopes: [], material: mesh.material ?? null, since: now });
      drop(state, mesh, { request: true });
    }
  }
  // A new caster this render no longer listed (out of the map's reach) is forgotten: listed again, it is new again,
  // and the map does not render again for it meanwhile.
  for (const mesh of state.leftOut.keys()) if (!state.seen.has(mesh)) drop(state, mesh, { leftOut: true });
  state.seen.clear();
  state.skipped.clear();
  state.decided.clear();
}

/**
 * Draws `generator`'s map with `render`, tracking which casters have drawn into it (WebGPU, a world view's own map).
 * `active` (a world view's steady frame, the map drawn before) isolates the draws of casters new to it; otherwise every
 * caster draws. Hidden meshes whose reveal asked the map are listed only to warm, whatever `active`. A caster draw
 * that throws leaves no scope open.
 */
export function renderTrackingCasters(generator: ShadowGenerator, active: boolean, render: () => void): void {
  const state = castersOf(generator);
  if (!state) {
    render();
    return;
  }
  // A first draw draws every caster it lists, from an empty map.
  if (!active && awaitsFirstDraw(generator)) state.drawn = new WeakSet();
  state.tracking = true;
  state.active = active;
  try {
    render();
  } finally {
    settle(state);
    state.tracking = false;
    state.active = false;
  }
}

/**
 * Whether `generator`'s map should render again now: when a hidden mesh waits for it to list it and the Engine frame
 * has warm budget left; and when it left out a caster, in a world view's steady frame (`steady`) once that caster's
 * pipelines exist (or their wait stalled), in any other frame at once, drawing it. Forgets disposed casters and
 * requests no reveal waits on.
 */
export function casterRedrawDue(generator: ShadowGenerator, steady: boolean): boolean {
  const state = maps.get(generator);
  if (!state || state.map !== generator.getShadowMap()) return false;
  let due = false;
  for (const [mesh, scopes] of state.leftOut) {
    if (mesh.isDisposed()) drop(state, mesh, { leftOut: true });
    else if (!steady || !waits(scopes)) due = true;
  }
  for (const mesh of state.requests.keys()) if (!isRevealPending(mesh)) drop(state, mesh, { request: true });
  return due || (state.requests.size > 0 && warmMapRoom(state.engine));
}

/** Whether `generator`'s map left out a caster new to it whose depth pipelines were still being created. */
export function leavesOutCasters(generator: ShadowGenerator): boolean {
  const state = maps.get(generator);
  if (!state || state.map !== generator.getShadowMap()) return false;
  for (const mesh of state.leftOut.keys()) if (!mesh.isDisposed()) return true;
  return false;
}

/** Whether the caster lists of `generator`'s map list the hidden `mesh` now: in a tracked render its reveal asked for. */
export function listsHiddenCaster(generator: ShadowGenerator, mesh: AbstractMesh): boolean {
  const state = maps.get(generator);
  return state?.tracking === true && state.requests.has(mesh);
}

/** A revealed mesh's requests are over (its reveal may skip the probe that would answer them). */
export function forgetCasterRequests(mesh: AbstractMesh): void {
  for (const state of [...(recordedIn.get(mesh) ?? [])]) if (state.requests.has(mesh)) drop(state, mesh, { request: true });
}

/** Lets `scene`'s shadow controller name the drawn maps a mesh's reveal redraws; `undefined` removes it. */
export function setShadowCasterReach(
  scene: Scene,
  reach: ((mesh: AbstractMesh, visit: (generator: ShadowGenerator) => void) => void) | undefined,
): void {
  if (reach) reaches.set(scene, reach);
  else reaches.delete(scene);
}

/**
 * The colour probe of a hidden mesh (WebGPU): whether its depth pipelines exist for every drawn map its reveal would
 * redraw, or creating them stalled. A map that has not listed it since it was hidden (or since its Material changed)
 * is asked to (`casterRedrawDue`), until `PIPELINE_DEFERRAL_STALL_MS` after the first ask. An instance and a mesh with
 * instances (they draw in one batch, which a skip would leave out whole) and a mesh staged for pipeline warm-up are
 * never listed.
 */
export function casterPipelinesWarm(mesh: AbstractMesh): boolean {
  const scene = mesh.getScene();
  const reach = reaches.get(scene);
  if (!reach || !pipelinesDeferred(scene.getEngine()) || mesh instanceof InstancedMesh || mesh.hasInstances ||
    isPipelineWarmupMesh(mesh)) return true;
  const material = mesh.material ?? null;
  const now = performance.now();
  let warm = true;
  reach(mesh, (generator) => {
    const state = castersOf(generator);
    if (!state) return;
    const warmed = state.warmed.get(mesh);
    if (warmed?.material === material) {
      // A warm draw never compiles synchronously: its wait ends at the Engine's stall or its own.
      if (waits(warmed.scopes) && !deferredPipelinesStalled(state.engine) && now - warmed.since < PIPELINE_DEFERRAL_STALL_MS)
        warm = false;
      return;
    }
    const since = state.requests.get(mesh);
    if (since === undefined) {
      state.requests.set(mesh, now);
      record(state, mesh);
      warm = false;
    } else if (now - since < PIPELINE_DEFERRAL_STALL_MS) warm = false;
    else {
      // No render listed it: its reveal waits no longer.
      state.warmed.set(mesh, { scopes: [], material, since: now });
      drop(state, mesh, { request: true });
    }
  });
  return warm;
}
