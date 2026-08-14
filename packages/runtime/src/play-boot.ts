import { unmatchedScriptSpawns } from "./play-load";
import type { CompiledScript } from "./script-host";

export type PlaySpawnEntry = {
  classId: string;
  variables?: Record<string, unknown>;
};

/** Minimal surface the Play boot sequence needs from `RuntimeDriver`. */
export type PlayBootRuntime = {
  loadScripts(scripts: readonly CompiledScript[]): Promise<void>;
  realizePlayWorld(): void;
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

  return {
    reset() {
      scriptsReady = Promise.resolve();
      navReady = Promise.resolve();
      pendingSpawn = [];
    },
    queueScripts(
      runtime: PlayBootRuntime,
      scripts: readonly CompiledScript[],
      spawn: readonly PlaySpawnEntry[],
    ) {
      pendingSpawn = [...spawn];
      scriptsReady = runtime.loadScripts(scripts).catch((error) => {
        runtime.reportError(error);
      });
    },
    queueNavMesh(runtime: PlayBootRuntime, bytes: Uint8Array) {
      if (!runtime.loadNavMesh) return;
      navReady = runtime.loadNavMesh(bytes).catch((error) => {
        runtime.reportError(error);
      });
    },
    async play(runtime: PlayBootRuntime): Promise<void> {
      await scriptsReady;
      await navReady;
      runtime.realizePlayWorld();
      const sceneClassIds = new Set(
        runtime.getWorld().getActors().map((actor) => actor.classId),
      );
      for (const entry of unmatchedScriptSpawns(pendingSpawn, sceneClassIds)) {
        runtime.spawnScriptedActor(entry);
      }
      try {
        await runtime.loadPhysics();
      } finally {
        runtime.start();
        runtime.resume();
      }
    },
  };
}
