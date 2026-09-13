import { createActor, createDefaultScene } from "@babylonslate/core";
import { createInProcessRuntime } from "./driver";
import { createPlayPauseGate } from "./play-pause-gate";
import { describe, expect, it, vi } from "vitest";
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

  it("does not spawn GameInstance, FunctionLibrary, or editor script classes as Actors", async () => {
    const runtime = fakeRuntime();
    const boot = createPlayBootCoordinator();
    boot.queueScripts(runtime, [], [
      { classId: "GameInstance" },
      { classId: "FunctionLibrary" },
      { classId: "EditorUtilityObject" },
      { classId: "EditorFunctionLibrary" },
      { classId: "Extra" },
    ]);
    await boot.play(runtime);
    expect(runtime.spawned).toEqual(["Extra"]);
  });

  it("reports a loadScripts failure and still starts Play", async () => {
    const reported: unknown[] = [];
    const runtime = fakeRuntime({
      loadScripts: async () => {
        throw new Error("compile failed");
      },
      reportError(error) {
        reported.push(error);
      },
    });
    const boot = createPlayBootCoordinator();
    boot.queueScripts(runtime, [], [{ classId: "Extra" }]);
    await boot.play(runtime);
    expect(reported).toHaveLength(1);
    expect(String(reported[0])).toContain("compile failed");
    expect(runtime.realized).toBe(true);
    expect(runtime.started).toBe(true);
  });

  it("does not start Play when loadPhysics rejects", async () => {
    const runtime = fakeRuntime({
      loadPhysics: async () => {
        throw new Error("havok missing");
      },
    });
    const boot = createPlayBootCoordinator();
    await expect(boot.play(runtime)).rejects.toThrow("havok missing");
    expect(runtime.started).toBe(false);
  });

  it("reset drops queued graph spawns from a previous session", async () => {
    const runtime = fakeRuntime();
    const boot = createPlayBootCoordinator();
    boot.queueScripts(runtime, [], [{ classId: "Extra" }]);
    boot.reset();
    await boot.play(runtime);
    expect(runtime.spawned).toEqual([]);
  });
  it("starts Game Instance during cooperative realization and physics loading without undoing Pause On Play", async () => {
    const chunk = deferred<void>();
    const physics = deferred<void>();
    const started = deferred<void>();
    let yielded = false;
    const runtime = createInProcessRuntime({ seed: 1, seedDemoActors: false, preferSoftwarePhysics: true,
      cooperativeSceneLoading: { yieldControl: () => { yielded = true; return chunk.promise; } },
      playScene: { ...createDefaultScene(), actors: Array.from({ length: 65 }, (_, index) => createActor(`a${index}`, "Actor")) },
    });
    vi.spyOn(runtime, "loadPhysics").mockReturnValue(physics.promise);
    const boot = createPlayBootCoordinator();
    const gate = createPlayPauseGate(runtime);
    const playing = gate.beginPlay((onStarted) => boot.play(runtime, () => { onStarted(); started.resolve(); }));
    gate.setPaused(true);
    try {
      await started.promise;
      await vi.waitFor(() => expect(yielded).toBe(true));
      runtime.tick();
      expect(runtime.getWorld().clock.tickIndex).toBe(0);
      gate.setPaused(false);
      runtime.tick();
      expect(runtime.getWorld().gameInstance!.getVariable("ticks")).toBe(1);
      expect(runtime.getWorld().getActors()).toHaveLength(0);
      chunk.resolve();
      await vi.waitFor(() => expect(runtime.getWorld().getActors()).toHaveLength(65));
      const actorTick = vi.spyOn(runtime.getWorld().getActors()[0]!, "callOnTick");
      runtime.tick();
      expect(runtime.getWorld().gameInstance!.getVariable("ticks")).toBe(2);
      expect(actorTick).not.toHaveBeenCalled();
      gate.setPaused(true);
      physics.resolve();
      await playing;
      runtime.tick();
      expect(runtime.getWorld().clock.tickIndex).toBe(2);
      gate.setPaused(false);
      runtime.tick();
      expect(actorTick).toHaveBeenCalledOnce();
    } finally { boot.reset(); gate.reset(); chunk.resolve(); physics.resolve(); runtime.stop(); }
  });

  it.each(["scripts", "physics"] as const)("reset rejects pending %s boot and prevents a late start", async (phase) => {
    const pending = deferred<void>();
    const enteredPhysics = deferred<void>();
    const runtime = fakeRuntime({
      loadScripts: () => phase === "scripts" ? pending.promise : Promise.resolve(),
      loadPhysics: () => { enteredPhysics.resolve(); return pending.promise; },
    });
    const boot = createPlayBootCoordinator();
    boot.queueScripts(runtime, [], [{ classId: "Extra" }]);
    const started = vi.fn();
    const playing = boot.play(runtime, started);
    const rejected = expect(playing).rejects.toMatchObject({ name: "AbortError" });
    if (phase === "physics") await enteredPhysics.promise;
    boot.reset();
    await rejected;
    pending.resolve();
    await Promise.resolve();
    expect(runtime.started).toBe(false);
    expect(started).not.toHaveBeenCalled();
    if (phase === "scripts") expect(runtime.spawned).toEqual([]);
  });

});
