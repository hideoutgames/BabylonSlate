import type { AbstractEngine, Scene } from "@babylonjs/core";
import {
  normalizeRenderPathOverrides,
  type RenderPathOverrides,
} from "@babylonslate/core";
import { publishSceneRenderPath, syncSceneRenderPath } from "./scene-render-path";

type RenderPathSession = {
  request: RenderPathOverrides;
  listeners: Set<(request: RenderPathOverrides) => void>;
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
