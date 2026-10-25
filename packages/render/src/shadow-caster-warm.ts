import type { AbstractEngine, AbstractMesh, ShadowGenerator } from "@babylonjs/core";
import { isPipelineWarmupMesh, isRevealPending } from "./reveal-pending";
import { isWarmShadowRender } from "./shadow-first-draw";
import { chargeWarmMap } from "./shadow-map-warm";
import {
  beginPipelineDeferral,
  deferredPipelineCount,
  deferredPipelinesStalled,
  type PipelineDeferral,
} from "./webgpu-pipeline-deferral";

/**
 * WebGPU: casters new to a shadow map that has drawn. Babylon's shadow pass creates a missing render pipeline
 * synchronously at its draw, and a caster whose depth variant or vertex layout no caster of the map drew (a spawn, a
 * mesh revealed or moved into the map's reach, an instanced, skinned or alpha-tested one) misses it. A warm render of
 * the whole map would clear what receivers sample, so the map's own real render handles them instead: each caster's
 * draw sits between Babylon's `onBeforeShadowMapRenderMeshObservable` and `onAfterShadowMapRenderMeshObservable`, and
 * in a world view's steady frame (`active`) the draws of a caster new to the map run inside a warm deferral scope
 * admitting the map's render passes. They are skipped, and a missing pipeline starts creating asynchronously with the
 * map's own target state, while every caster that has drawn into the map draws as before: the map keeps all it held,
 * and the new caster joins it once its pipelines exist, as a caster still compiling does on WebGL2. A mesh still hidden
 * for its reveal (`isRevealPending`) is listed in such a render only for this (the controller's caster list), so its
 * reveal can wait for its depth pipelines (`casterPipelinesWarm`) and its shadow appears with it.
 *
 * A caster is new to a map until a real draw of that map has drawn it; a caster that has drawn keeps drawing, a later
 * depth variant of its own included (a changed Material), which still creates its pipeline in the draw, since leaving
 * it out would drop a shadow the map holds. A new caster's warm-skipped draws all finding their pipelines (or one
 * failing to create, which its draw then reports) lets it draw at the map's next render, which is due at once
 * (`casterRedrawDue`). The wait ends at the deferral's stall (`deferredPipelinesStalled`), when it draws and creates
 * what is still missing synchronously. Pipelines its draws start are charged to the Engine frame's warm budget
 * (`WARM_MAP_PIPELINES_PER_FRAME`), which a real render cannot wait for, so the frame's other warm renders wait instead.
 */
type MapCasters = {
  engine: AbstractEngine;
  /** Casters a real draw of the map drew. */
  drawn: WeakSet<AbstractMesh>;
  /** New casters whose last render was warm-skipped: the scopes that wait for their depth pipelines. */
  warming: Map<AbstractMesh, PipelineDeferral[]>;
  /** The render in progress is a world view's steady frame's: new casters are warm-skipped. */
  active: boolean;
  /** Casters this render listed. */
  seen: Set<AbstractMesh>;
  /** This render's decision per caster (a mesh's parts draw alike), and the scopes of those it skipped. */
  decided: Map<AbstractMesh, boolean>;
  skipped: Map<AbstractMesh, PipelineDeferral[]>;
  /** The skipped caster draw in progress. */
  open: { scope: PipelineDeferral; pendingBefore: number } | undefined;
};

const maps = new WeakMap<ShadowGenerator, MapCasters>();
/** Hidden meshes' warm-skipped draws, by map, from each map's last render that listed them. */
const hidden = new WeakMap<AbstractMesh, Map<ShadowGenerator, PipelineDeferral[]>>();

function waits(scopes: readonly PipelineDeferral[]): boolean {
  return scopes.some((scope) => scope.waiting());
}

function skips(state: MapCasters, mesh: AbstractMesh): boolean {
  let skip = state.decided.get(mesh);
  if (skip !== undefined) return skip;
  const scopes = state.warming.get(mesh);
  skip = isRevealPending(mesh) ||
    (!state.drawn.has(mesh) && (!scopes || (waits(scopes) && !deferredPipelinesStalled(state.engine))));
  state.decided.set(mesh, skip);
  return skip;
}

/** The map's caster bookkeeping, its draw observers installed on first use. */
function castersOf(generator: ShadowGenerator): MapCasters {
  let state = maps.get(generator);
  if (state) return state;
  const engine = generator.getLight().getScene().getEngine();
  const own: MapCasters = {
    engine, drawn: new WeakSet(), warming: new Map(), active: false, seen: new Set(), decided: new Map(), skipped: new Map(),
    open: undefined,
  };
  maps.set(generator, own);
  state = own;
  generator.onBeforeShadowMapRenderMeshObservable.add((mesh) => {
    own.seen.add(mesh);
    if (!own.active || own.open || !skips(own, mesh)) return;
    const passes = generator.getShadowMap()?.renderPassIds ?? [];
    const pendingBefore = deferredPipelineCount(engine);
    const scope = beginPipelineDeferral(engine, (pass) => passes.includes(pass), { warm: true });
    if (scope) own.open = { scope, pendingBefore };
  });
  generator.onAfterShadowMapRenderMeshObservable.add((mesh) => {
    const open = own.open;
    if (open) {
      own.open = undefined;
      open.scope.close();
      chargeWarmMap(engine, open.pendingBefore);
      let scopes = own.skipped.get(mesh);
      if (!scopes) own.skipped.set(mesh, (scopes = []));
      scopes.push(open.scope);
      return;
    }
    // The whole-map warm render of a first draw draws nothing; a hidden mesh is drawn only to warm.
    if (isWarmShadowRender(generator) || isRevealPending(mesh)) return;
    own.drawn.add(mesh);
    own.warming.delete(mesh);
    hidden.delete(mesh);
  });
  return state;
}

/**
 * Draws `generator`'s map with `render`, tracking which casters have drawn into it (WebGPU, a world view's own map).
 * `active` (a world view's steady frame, the map drawn before) warm-skips new casters' draws; otherwise every caster
 * draws. A caster draw that throws leaves no scope open.
 */
export function renderTrackingCasters(generator: ShadowGenerator, active: boolean, render: () => void): void {
  const state = castersOf(generator);
  state.active = active;
  try {
    render();
  } finally {
    if (state.open) {
      state.open.scope.close();
      chargeWarmMap(state.engine, state.open.pendingBefore);
      state.open = undefined;
    }
    state.active = false;
    // A new caster this render no longer listed (out of the map's reach) whose pipelines settled is forgotten: listed
    // again, it is new again, and finds them.
    for (const [mesh, scopes] of state.warming) if (!state.seen.has(mesh) && !waits(scopes)) state.warming.delete(mesh);
    for (const [mesh, scopes] of state.skipped) {
      state.warming.set(mesh, scopes);
      if (!isRevealPending(mesh)) continue;
      let warms = hidden.get(mesh);
      if (!warms) hidden.set(mesh, (warms = new Map()));
      warms.set(generator, scopes);
    }
    state.seen.clear();
    state.skipped.clear();
    state.decided.clear();
  }
}

/** Whether `generator`'s map renders a world view's steady frame now, listing hidden casters only to warm them. */
export function listsHiddenCaster(generator: ShadowGenerator, mesh: AbstractMesh): boolean {
  return maps.get(generator)?.active === true && !isPipelineWarmupMesh(mesh);
}

/**
 * Whether a new caster `generator`'s map left out may draw now (its pipelines exist, failed or stalled): the map should
 * render again. Forgets casters gone since.
 */
export function casterRedrawDue(generator: ShadowGenerator): boolean {
  const state = maps.get(generator);
  if (!state?.warming.size) return false;
  let due = false;
  for (const [mesh, scopes] of state.warming) {
    if (mesh.isDisposed()) state.warming.delete(mesh);
    else if (!isRevealPending(mesh) && (!waits(scopes) || deferredPipelinesStalled(state.engine))) due = true;
  }
  return due;
}

/**
 * Whether a hidden mesh's caster depth pipelines exist for every drawn map whose last render listed it (none listed it
 * yet counts as warm: a map it joins later leaves it out until they exist), or creating them stalled.
 */
export function casterPipelinesWarm(mesh: AbstractMesh): boolean {
  const warms = hidden.get(mesh);
  if (!warms) return true;
  for (const [generator, scopes] of warms) {
    if (!generator.getShadowMap()) warms.delete(generator);
    else if (waits(scopes) && !deferredPipelinesStalled(maps.get(generator)!.engine)) return false;
  }
  return true;
}
