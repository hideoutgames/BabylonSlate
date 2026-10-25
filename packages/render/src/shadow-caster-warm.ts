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
import { awaitsFirstDraw, isWarmShadowRender } from "./shadow-first-draw";
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
 * the draws of a caster the map has not drawn run inside a warm deferral scope admitting the map's render passes. They
 * are skipped, and a missing pipeline starts creating asynchronously with the map's own target state, while every
 * caster that has drawn into the map draws as before. A render whose skipped casters found every pipeline they need
 * renders the map again at once, drawing them; one still being created leaves its caster out until it exists
 * (`casterRedrawDue`), as a caster still compiling is left out on WebGL2. The map keeps all it held.
 *
 * A mesh hidden for its reveal (`isRevealPending`) casts into no map. Its colour probe asks each drawn map its reveal
 * would redraw (the controller's `setShadowCasterReach`) for its depth pipelines (`casterPipelinesWarm`): a map that
 * has not listed it since it was hidden is asked to render again (within the frame's warm budget), listing it only so
 * its draws start them, all of them skipped, and the reveal waits until they exist, so the mesh appears with its
 * shadow and the redraw its reveal starts creates none.
 *
 * A caster that has drawn into the map keeps drawing, a later depth variant of its own included (a changed Material
 * whose colour variant is ready, a mesh's first instances), which still creates its pipeline in the draw, since leaving
 * it out would drop a shadow the map holds. Waits end at the deferral's stall (`deferredPipelinesStalled`), when the
 * caster draws and creates what is still missing synchronously, and a reveal's wait for a map that never lists the
 * mesh after `PIPELINE_DEFERRAL_STALL_MS`. Pipelines skipped draws start are charged to the Engine frame's warm budget
 * (`WARM_MAP_PIPELINES_PER_FRAME`), which a real render cannot wait for, so the frame's other warm renders wait
 * instead. A frame that is not a steady one (a strict frame, one that publishes a manual capture) draws every caster
 * the map left out (`leavesOutCasters`), creating its pipelines in the draw.
 */
type Skips = PipelineDeferral[];

type MapCasters = {
  map: RenderTargetTexture;
  engine: AbstractEngine;
  /** Casters a real draw of the map drew. */
  drawn: WeakSet<AbstractMesh>;
  /** Casters new to the map that its last render listing them left out: their skipped draws' scopes. */
  leftOut: Map<AbstractMesh, Skips>;
  /**
   * Hidden meshes a render listed since they were hidden (`listsHiddenCaster`): their skipped draws' scopes, none when
   * the caster lists left them out, with the Material they had.
   */
  warmed: Map<AbstractMesh, { scopes: Skips; material: Material | null }>;
  /** Hidden meshes whose reveal waits for the map to list them, since when. */
  requests: Map<AbstractMesh, number>;
  /** The render in progress is a world view's steady frame's: casters new to the map are skipped. */
  active: boolean;
  /** Skipped casters of this frame's earlier render that found every pipeline: they draw in this one. */
  admitted: Set<AbstractMesh>;
  /** This render's casters, its decision per caster (a mesh's parts draw alike) and the scopes of those it skipped. */
  seen: Set<AbstractMesh>;
  decided: Map<AbstractMesh, boolean>;
  skipped: Map<AbstractMesh, Skips>;
  /** The skipped caster draw in progress. */
  open: { scope: PipelineDeferral; pendingBefore: number } | undefined;
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

function skips(state: MapCasters, mesh: AbstractMesh): boolean {
  let skip = state.decided.get(mesh);
  if (skip === undefined) {
    skip = isRevealPending(mesh) || (!state.drawn.has(mesh) && !state.admitted.has(mesh));
    state.decided.set(mesh, skip);
  }
  return skip;
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
    requests: new Map(), active: false, admitted: new Set(), seen: new Set(), decided: new Map(), skipped: new Map(),
    open: undefined,
  };
  maps.set(generator, state);
  map.onDisposeObservable.addOnce(() => release(state));
  if (observed.has(generator)) return state;
  observed.add(generator);
  generator.onBeforeShadowMapRenderMeshObservable.add((rendering) => {
    const own = maps.get(generator);
    if (!own) return;
    const mesh = casterOf(rendering);
    own.seen.add(mesh);
    if (!own.active || own.open || !skips(own, mesh)) return;
    const passes = own.map.renderPassIds;
    const pendingBefore = deferredPipelineCount(own.engine);
    const scope = beginPipelineDeferral(own.engine, (pass) => passes.includes(pass), { warm: true });
    if (scope) own.open = { scope, pendingBefore };
  });
  generator.onAfterShadowMapRenderMeshObservable.add((rendering) => {
    const own = maps.get(generator);
    if (!own) return;
    const mesh = casterOf(rendering);
    const open = own.open;
    if (open) {
      own.open = undefined;
      open.scope.close();
      chargeWarmMap(own.engine, open.pendingBefore);
      let scopes = own.skipped.get(mesh);
      if (!scopes) own.skipped.set(mesh, (scopes = []));
      scopes.push(open.scope);
      return;
    }
    // The whole-map warm render of a first draw draws nothing; a hidden mesh is listed only to warm.
    if (isWarmShadowRender(generator) || isRevealPending(mesh)) return;
    own.drawn.add(mesh);
    if (own.leftOut.has(mesh) || own.warmed.has(mesh)) drop(own, mesh, { leftOut: true, warmed: true });
  });
  return state;
}

/** Records one render; returns the skipped casters that found every pipeline (or whose wait stalled): they draw now. */
function settle(state: MapCasters): AbstractMesh[] {
  if (state.open) {
    state.open.scope.close();
    chargeWarmMap(state.engine, state.open.pendingBefore);
    state.open = undefined;
  }
  const stalled = deferredPipelinesStalled(state.engine);
  const admit: AbstractMesh[] = [];
  for (const [mesh, scopes] of state.skipped) {
    record(state, mesh);
    if (isRevealPending(mesh)) {
      state.warmed.set(mesh, { scopes, material: mesh.material ?? null });
      state.requests.delete(mesh);
      continue;
    }
    state.leftOut.set(mesh, scopes);
    if (state.active && (stalled || !waits(scopes))) admit.push(mesh);
  }
  // A steady frame's render answered every request: a hidden mesh it did not draw has nothing to warm in this map.
  if (state.active) {
    for (const [mesh] of state.requests) {
      if (state.skipped.has(mesh)) continue;
      state.warmed.set(mesh, { scopes: [], material: mesh.material ?? null });
      state.requests.delete(mesh);
    }
  }
  // A new caster this render no longer drew or skipped (out of the map's reach) is forgotten: listed again, it is new
  // again, and the map does not render again for it meanwhile.
  for (const mesh of state.leftOut.keys()) if (!state.seen.has(mesh)) drop(state, mesh, { leftOut: true });
  state.seen.clear();
  state.skipped.clear();
  state.decided.clear();
  return admit;
}

/**
 * Draws `generator`'s map with `render`, tracking which casters have drawn into it (WebGPU, a world view's own map).
 * `active` (a world view's steady frame, the map drawn before) skips the draws of casters new to it, and renders the
 * map again at once when those found every pipeline they need; otherwise every caster draws. A caster draw that
 * throws leaves no scope open.
 */
export function renderTrackingCasters(generator: ShadowGenerator, active: boolean, render: () => void): void {
  const state = castersOf(generator);
  if (!state) {
    render();
    return;
  }
  // A first draw draws every caster it lists, from an empty map.
  if (!active && awaitsFirstDraw(generator)) state.drawn = new WeakSet();
  state.active = active;
  let admit: AbstractMesh[];
  try {
    try {
      render();
    } finally {
      admit = settle(state);
    }
    if (!admit.length) return;
    for (const mesh of admit) state.admitted.add(mesh);
    try {
      render();
    } finally {
      settle(state);
    }
  } finally {
    state.active = false;
    state.admitted.clear();
  }
}

/**
 * Whether `generator`'s map should render again now: in a world view's steady frame (`steady`), when a caster it left
 * out has its pipelines (or their wait stalled), or a hidden mesh waits for it to list it and the Engine frame has warm
 * budget left; in any other frame, when it left a caster out at all, which then draws. Forgets disposed casters.
 */
export function casterRedrawDue(generator: ShadowGenerator, steady: boolean): boolean {
  const state = maps.get(generator);
  if (!state || state.map !== generator.getShadowMap()) return false;
  let due = false;
  for (const [mesh, scopes] of state.leftOut) {
    if (mesh.isDisposed()) drop(state, mesh, { leftOut: true });
    else if (!steady || !waits(scopes) || deferredPipelinesStalled(state.engine)) due = true;
  }
  return due || (steady && state.requests.size > 0 && warmMapRoom(state.engine));
}

/** Whether `generator`'s map left out a caster new to it whose depth pipelines were still being created. */
export function leavesOutCasters(generator: ShadowGenerator): boolean {
  const state = maps.get(generator);
  if (!state || state.map !== generator.getShadowMap()) return false;
  for (const mesh of state.leftOut.keys()) if (!mesh.isDisposed()) return true;
  return false;
}

/**
 * Whether the caster lists of `generator`'s map list the hidden `mesh` now: only in a world view's steady frame, and
 * only while its reveal waits for the map to list it.
 */
export function listsHiddenCaster(generator: ShadowGenerator, mesh: AbstractMesh): boolean {
  const state = maps.get(generator);
  return state?.active === true && state.requests.has(mesh);
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
 * redraw, or their creation stalled. A map that has not listed it since it was hidden (or since its Material changed)
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
      if (waits(warmed.scopes) && !deferredPipelinesStalled(state.engine)) warm = false;
      return;
    }
    const since = state.requests.get(mesh);
    if (since === undefined) {
      state.requests.set(mesh, now);
      record(state, mesh);
      warm = false;
    } else if (now - since < PIPELINE_DEFERRAL_STALL_MS) warm = false;
    else {
      // The map never listed it: its reveal waits no longer.
      state.warmed.set(mesh, { scopes: [], material });
      state.requests.delete(mesh);
    }
  });
  return warm;
}
