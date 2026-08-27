import { describe, expect, it } from "vitest";
import { ClassRegistry } from "./class-registry";
import { GameInstance } from "./objects";
import { TICK_PHASES } from "./tick";
import { World } from "./world";
import { createWorldSnapshot, stringifyWorldSnapshot } from "./snapshot";

function createTestWorld(seed = 1) {
  let n = 0;
  const registry = new ClassRegistry();
  const world = new World({
    seed,
    dt: 1 / 60,
    classRegistry: registry,
    guidFactory: () => `id-${++n}`,
  });
  world.setGameInstance(
    new GameInstance({
      classId: "GameInstance",
      guid: "gi",
      variables: { score: 0 },
      hooks: {
        onTick: (self) => {
          self.setVariable("score", Number(self.getVariable("score")) + 1);
        },
      },
    }),
  );
  return world;
}

describe("World tick", () => {
  it("runs phases in deterministic order including empty physics", () => {
    const phases: string[] = [];
    let n = 0;
    const world = new World({
      seed: 7,
      dt: 0.016,
      classRegistry: new ClassRegistry(),
      guidFactory: () => `g-${++n}`,
      onPhase: (phase) => {
        phases.push(phase);
      },
    });
    world.setGameInstance(
      new GameInstance({ classId: "GameInstance", guid: "gi" }),
    );
    world.tick();
    expect(phases).toEqual([...TICK_PHASES]);
  });

  it("ticks GameInstance, then actors in spawn order, then components", () => {
    const order: string[] = [];
    const world = createTestWorld();
    const a1 = world.createActor({
      classId: "Actor",
      hooks: { onTick: () => order.push("a1") },
    });
    const a2 = world.createActor({
      classId: "Actor",
      hooks: { onTick: () => order.push("a2") },
    });
    const c1 = world.createComponent({
      classId: "MeshComponent",
      hooks: { onTick: () => order.push("c1") },
    });
    a1.attachComponent(c1);
    world.spawnActorNow(a1);
    world.spawnActorNow(a2);
    world.gameInstance = new GameInstance({
      classId: "GameInstance",
      guid: "gi",
      hooks: { onTick: () => order.push("gi") },
    });
    world.tick();
    expect(order).toEqual(["gi", "a1", "a2", "c1"]);
  });

  it("defers mid-tick destroy so siblings still tick", () => {
    const order: string[] = [];
    const world = createTestWorld();
    const a1 = world.createActor({
      classId: "Actor",
      hooks: {
        onTick: (self) => {
          order.push("a1");
          world.destroyActor(self.guid);
        },
      },
    });
    const a2 = world.createActor({
      classId: "Actor",
      hooks: { onTick: () => order.push("a2") },
    });
    world.spawnActorNow(a1);
    world.spawnActorNow(a2);
    world.tick();
    expect(order).toEqual(["a1", "a2"]);
    expect(world.getActors().map((a) => a.guid)).toEqual([a2.guid]);
  });

  it("defers mid-tick spawnActorNow until after the phase", () => {
    const order: string[] = [];
    const world = createTestWorld();
    const a1 = world.createActor({
      classId: "Actor",
      hooks: {
        onTick: () => {
          order.push("a1");
          const child = world.createActor({
            classId: "Actor",
            hooks: { onTick: () => order.push("child") },
          });
          world.spawnActorNow(child);
        },
      },
    });
    world.spawnActorNow(a1);
    world.tick();
    // Child must not tick in the same actors phase it was spawned.
    expect(order).toEqual(["a1"]);
    expect(world.getActors()).toHaveLength(2);
    world.tick();
    expect(order).toEqual(["a1", "a1", "child"]);
  });

  it("applies inherited variable defaults and interfaces from the class registry", () => {
    const world = createTestWorld();
    world.classRegistry.register({
      id: "Enemy",
      parentClassId: "Actor",
      kind: "actor",
      variables: [
        { name: "health", type: "float", defaultValue: 100 },
        { name: "speed", type: "float", defaultValue: 1 },
      ],
      implementedInterfaces: ["iface-damageable"],
    });
    const actor = world.createActor({ classId: "Enemy" });
    expect(actor.getVariable("health")).toBe(100);
    expect(actor.getVariable("speed")).toBe(1);
    expect(actor.implementedInterfaces).toEqual(["iface-damageable"]);
  });

  it("lets caller variables and interfaces override class defaults", () => {
    const world = createTestWorld();
    world.classRegistry.register({
      id: "Enemy",
      parentClassId: "Actor",
      kind: "actor",
      variables: [{ name: "health", type: "float", defaultValue: 100 }],
      implementedInterfaces: ["iface-damageable"],
    });
    const actor = world.createActor({
      classId: "Enemy",
      variables: { health: 50, tag: "elite" },
      implementedInterfaces: ["iface-stunned"],
    });
    expect(actor.getVariable("health")).toBe(50);
    expect(actor.getVariable("tag")).toBe("elite");
    expect(actor.implementedInterfaces).toEqual(["iface-stunned"]);
  });

  it("applies inherited component variable defaults", () => {
    const world = createTestWorld();
    world.classRegistry.register({
      id: "HealthComponent",
      parentClassId: "ActorComponent",
      kind: "component",
      variables: [{ name: "max", type: "float", defaultValue: 10 }],
      implementedInterfaces: [],
    });
    const component = world.createComponent({ classId: "HealthComponent" });
    expect(component.getVariable("max")).toBe(10);
  });

  it("runs GameInstance init, scene load/exit, and application end hooks", () => {
    const events: string[] = [];
    const world = createTestWorld();
    world.setGameInstance(
      new GameInstance({
        classId: "GameInstance",
        guid: "gi",
        hooks: {
          onCreation: () => events.push("create"),
          onGameStart: () => events.push("start"),
          onTick: () => events.push("tick"),
          onGameEnd: () => events.push("end"),
          onSceneStartLoading: (_self, sceneName) =>
            events.push(`start:${sceneName}`),
          onSceneFinishLoading: (_self, sceneName) =>
            events.push(`finish:${sceneName}`),
          onFirstSceneLoaded: (_self, sceneName) =>
            events.push(`first:${sceneName}`),
          onSceneExit: (_self, sceneName) => events.push(`exit:${sceneName}`),
        },
      }),
    );
    world.start();
    world.loadScene("Level1");
    world.loadScene("Level2");
    world.tick();
    world.end();
    expect(events).toEqual([
      "create",
      "start",
      "start:Level1",
      "finish:Level1",
      "first:Level1",
      "exit:Level1",
      "start:Level2",
      "finish:Level2",
      "tick",
      "exit:Level2",
      "end",
    ]);
    expect(events.filter((event) => event === "end")).toHaveLength(1);
    expect(events.filter((event) => event.startsWith("first:"))).toHaveLength(1);
  });

  it("fires OnSceneExit for a scene that started loading but never finished", () => {
    const events: string[] = [];
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: new ClassRegistry(),
    });
    world.setGameInstance(
      new GameInstance({
        classId: "GameInstance",
        guid: "gi",
        hooks: {
          onCreation: () => events.push("create"),
          onGameStart: () => events.push("start"),
          onGameEnd: () => events.push("end"),
          onSceneStartLoading: (_self, sceneName) =>
            events.push(`start:${sceneName}`),
          onSceneFinishLoading: (_self, sceneName) =>
            events.push(`finish:${sceneName}`),
          onSceneExit: (_self, sceneName) => events.push(`exit:${sceneName}`),
        },
      }),
    );
    world.start();
    world.beginSceneLoad("Level1");
    world.createScene({ assetGuid: "scene-1", sceneName: "Level1" });
    world.end();
    expect(events).toEqual([
      "create",
      "start",
      "start:Level1",
      "exit:Level1",
      "end",
    ]);
  });

  it("flushes spawn then destroy in the same tick so the actor does not remain", () => {
    const world = createTestWorld();
    const events: string[] = [];
    const actor = world.createActor({
      classId: "Actor",
      hooks: {
        onCreation: () => events.push("create"),
        onDestroyed: () => events.push("destroy"),
      },
    });
    world.spawnActor(actor);
    world.destroyActor(actor.guid);
    world.tick();
    expect(world.getActors()).toHaveLength(0);
    expect(events).toEqual(["create", "destroy"]);
  });

  it("produces identical snapshots for the same seed", () => {
    const run = (seed: number) => {
      const world = createTestWorld(seed);
      const actor = world.createActor({
        classId: "Actor",
        variables: { n: 0 },
        hooks: {
          onTick: (self, ctx) => {
            const bump = ctx.world.rngNextFloat();
            self.setVariable("n", Number(self.getVariable("n")) + bump);
            self.transform.position.x += bump;
          },
        },
      });
      world.spawnActorNow(actor);
      for (let i = 0; i < 10; i++) world.tick();
      return stringifyWorldSnapshot(createWorldSnapshot(world));
    };
    expect(run(42)).toBe(run(42));
    expect(run(42)).not.toBe(run(43));
  });
});
