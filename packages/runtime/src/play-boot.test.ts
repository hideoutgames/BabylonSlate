import { describe, expect, it } from "vitest";
import { createPlayBootCoordinator, type PlayBootRuntime } from "./play-boot";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeRuntime(overrides: Partial<PlayBootRuntime> = {}): PlayBootRuntime & {
  realized: boolean;
  started: boolean;
  spawned: string[];
} {
  const actors: { classId: string }[] = [];
  const runtime = {
    realized: false,
    started: false,
    spawned: [] as string[],
    loadScripts: async () => {},
    realizePlayWorld() {
      runtime.realized = true;
      if (actors.length === 0) actors.push({ classId: "Mover" });
    },
    getWorld() {
      return { getActors: () => actors };
    },
    spawnScriptedActor(entry: { classId: string }) {
      runtime.spawned.push(entry.classId);
      return null;
    },
    loadPhysics: async () => {},
    start() {
      runtime.started = true;
    },
    resume() {},
    reportError() {},
    ...overrides,
  };
  return runtime;
}

describe("createPlayBootCoordinator", () => {
  it("waits for loadScripts before realizePlayWorld so Begin Play binds on spawn", async () => {
    const scripts = deferred<void>();
    let scriptsLoaded = false;
    let realizedAfterScripts = false;
    const runtime = fakeRuntime({
      loadScripts: () =>
        scripts.promise.then(() => {
          scriptsLoaded = true;
        }),
      realizePlayWorld() {
        realizedAfterScripts = scriptsLoaded;
      },
    });
    const boot = createPlayBootCoordinator();
    boot.queueScripts(runtime, [], []);
    const playing = boot.play(runtime);
    expect(scriptsLoaded).toBe(false);
    scripts.resolve();
    await playing;
    expect(realizedAfterScripts).toBe(true);
    expect(runtime.started).toBe(true);
  });

  it("imports the baked navmesh before realizePlayWorld so agents register on spawn", async () => {
    const nav = deferred<void>();
    let navLoaded = false;
    let realizedAfterNav = false;
    const runtime = fakeRuntime({
      loadNavMesh: () =>
        nav.promise.then(() => {
          navLoaded = true;
        }),
      realizePlayWorld() {
        realizedAfterNav = navLoaded;
      },
    });
    const boot = createPlayBootCoordinator();
    boot.queueNavMesh(runtime, new Uint8Array([1, 2, 3]));
    const playing = boot.play(runtime);
    expect(navLoaded).toBe(false);
    nav.resolve();
    await playing;
    expect(realizedAfterNav).toBe(true);
  });

  it("skips graph spawns whose class already exists after realize", async () => {
    const runtime = fakeRuntime();
    const boot = createPlayBootCoordinator();
    boot.queueScripts(runtime, [], [
      { classId: "Mover" },
      { classId: "Extra" },
    ]);
    await boot.play(runtime);
    expect(runtime.spawned).toEqual(["Extra"]);
  });
});
