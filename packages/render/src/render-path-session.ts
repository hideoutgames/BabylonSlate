import type { AbstractEngine, Scene } from "@babylonjs/core";
import {
  normalizeRenderPathOverrides,
  type RenderPathOverrides,
} from "@babylonslate/core";
import { publishSceneRenderPath, syncSceneRenderPath } from "./scene-render-path";

type RenderPathSession = {
  request: RenderPathOverrides;
  listeners: Set<(request: RenderPathOverrides) => void>;
  play?: { views: number; editorRequest: RenderPathOverrides };
};

const sessions = new WeakMap<AbstractEngine, RenderPathSession>();

function ensureSession(engine: AbstractEngine): RenderPathSession {
  let entry = sessions.get(engine);
  if (!entry) {
    entry = { request: {}, listeners: new Set() };
    sessions.set(engine, entry);
    engine.onDisposeObservable.addOnce(() => {
      sessions.delete(engine);
    });
  }
  return entry;
}

/** The Engine-wide session render path request; empty means the project path. */
export function renderPathSession(
  engine: AbstractEngine,
): RenderPathOverrides {
  return sessions.get(engine)?.request ?? {};
}

/** Shared Play views own one game session, distinct from the editor's request. */
export function retainPlayRenderPathSession(engine: AbstractEngine): () => void {
  const entry = ensureSession(engine);
  const first = !entry.play;
  const scope = entry.play ??= { views: 0, editorRequest: { ...entry.request } };
  scope.views += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    scope.views -= 1;
    if (scope.views === 0 && entry.play === scope) {
      entry.play = undefined;
      if (sessions.get(engine) === entry) requestRenderPath(engine, scope.editorRequest);
    }
  };
  try { if (first) requestRenderPath(engine, {}); }
  catch (error) {
    try { release(); }
    catch (restoreError) { throw new AggregateError([error, restoreError], "Play render-path session could not start or restore."); }
    throw error;
  }
  return release;
}

/**
 * Apply a non-persistent game-wide session render path to every live Scene on
 * the Engine. Returns false when the normalized request did not change.
 */
export function requestRenderPath(
  engine: AbstractEngine,
  request: RenderPathOverrides,
): boolean {
  const normalized = normalizeRenderPathOverrides(request);
  const entry = ensureSession(engine);
  if (entry.request.renderPath === normalized.renderPath) return false;
  entry.request = normalized;
  for (const scene of engine.scenes as Iterable<Scene>) {
    if (scene.isDisposed) continue;
    syncSceneRenderPath(scene);
    publishSceneRenderPath(scene);
  }
  for (const listener of entry.listeners) listener(entry.request);
  return true;
}

/** Subscribe to session render path requests; returns an unsubscribe. */
export function subscribeRenderPathSession(
  engine: AbstractEngine,
  listener: (request: RenderPathOverrides) => void,
): () => void {
  const entry = ensureSession(engine);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}
