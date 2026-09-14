import { sceneRealizationCancelled, waitForSceneWork } from "./scene-realization-work";
import { unmatchedScriptSpawns } from "./play-load";
import type { CompiledScript } from "./script-host";

export type PlaySpawnEntry = {
  classId: string;
  variables?: Record<string, unknown>;
};

/** Minimal surface the Play boot sequence needs from `RuntimeDriver`. */
export type PlayBootRuntime = {
  loadScripts(scripts: readonly CompiledScript[]): Promise<void>;
  realizePlayWorld(): void | Promise<void>;
  beginPlayLoading?(): boolean;
  finishPlayLoading?(): void;
  stop?(): void;
  getWorld(): { getActors(): readonly { classId: string }[] };
  spawnScriptedActor(options: PlaySpawnEntry): unknown;
  loadPhysics(): Promise<void>;
  loadNavMesh?(bytes: Uint8Array): Promise<void>;
  start(): void;
  resume(): void;
  reportError(error: unknown): void;
};

/**
 * Serialize Play startup so compiled scripts load before scene actors spawn.
 * Worker `loadScripts` is async; `play` must not realize the world first.
 */
export function createPlayBootCoordinator() {
  let scriptsReady: Promise<void> = Promise.resolve();
  let navReady: Promise<void> = Promise.resolve();
  let pendingSpawn: PlaySpawnEntry[] = [];
  let cancellation = new AbortController();
  let playing: Promise<void> | null = null;

  return {
    reset() {
      cancellation.abort(sceneRealizationCancelled());
      cancellation = new AbortController();
      playing = null;
      scriptsReady = Promise.resolve();
      navReady = Promise.resolve();
      pendingSpawn = [];
    },
    queueScripts(
      runtime: PlayBootRuntime,
      scripts: readonly CompiledScript[],
      spawn: readonly PlaySpawnEntry[],
    ) {
      const signal = cancellation.signal;
      pendingSpawn = [...spawn];
      scriptsReady = runtime.loadScripts(scripts).catch((error) => {
        if (!signal.aborted) runtime.reportError(error);
      });
    },
    queueNavMesh(runtime: PlayBootRuntime, bytes: Uint8Array) {
      if (!runtime.loadNavMesh) return;
      const signal = cancellation.signal;
      navReady = runtime.loadNavMesh(bytes).catch((error) => {
        if (!signal.aborted) runtime.reportError(error);
      });
    },
    play(runtime: PlayBootRuntime, onStarted?: () => void): Promise<void> {
      if (playing) return playing;
      const signal = cancellation.signal;
      const scripts = scriptsReady;
      const nav = navReady;
      const spawn = pendingSpawn;
      playing = (async () => {
        let startedEarly = false;
        try {
          await waitForSceneWork(scripts, signal);
          await waitForSceneWork(nav, signal);
          signal.throwIfAborted();
          startedEarly = runtime.beginPlayLoading?.() === true;
          if (startedEarly) onStarted?.();
          signal.throwIfAborted();
          await waitForSceneWork(Promise.resolve(runtime.realizePlayWorld()), signal);
          const sceneClassIds = new Set(runtime.getWorld().getActors().map((actor) => actor.classId));
          for (const entry of unmatchedScriptSpawns(spawn, sceneClassIds)) {
            signal.throwIfAborted();
            runtime.spawnScriptedActor(entry);
          }
          await waitForSceneWork(runtime.loadPhysics(), signal);
          signal.throwIfAborted();
          if (startedEarly) runtime.finishPlayLoading?.();
          else {
            runtime.start();
            runtime.resume();
            onStarted?.();
          }
        } catch (error) {
          if (startedEarly && !signal.aborted) runtime.stop?.();
          throw error;
        }
      })();
      return playing;
    },
  };
}
