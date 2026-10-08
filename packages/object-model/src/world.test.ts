import { describe, expect, it } from "vitest";
import { ClassRegistry } from "./class-registry";
import {
  GameInstance,
  Scene,
  SceneStreamingActor,
  type GameSubsystem,
  type SceneSubsystemHooks,
  type Subsystem,
} from "./objects";
import { TICK_PHASES } from "./tick";
import { DuplicateActorGuidError, World } from "./world";
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

  it("keeps Game Instance ticking while scene phases are suspended and resumes those phases later", () => {
    const order: string[] = [];
    let ready = false;
    const world = new World({
      seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry(),
      canTickScene: () => ready,
      onPhysics: () => { order.push("physics"); },
    });
    world.setGameInstance(new GameInstance({ classId: "GameInstance", hooks: { onTick: () => { order.push("gi"); } } }));
    const actor = world.createActor({ classId: "Actor", hooks: { onTick: () => { order.push("actor"); } } });
    actor.attachComponent(world.createComponent({ classId: "ActorComponent", hooks: { onTick: () => { order.push("component"); } } }));
    world.spawnActorNow(actor);
    world.tick();
    expect(order).toEqual(["gi"]);
    ready = true;
    world.tick();
    expect(order).toEqual(["gi", "gi", "actor", "component", "physics"]);
    expect(world.clock.tickIndex).toBe(2);
  });

  it.each(["gi", "actor"] as const)("stops remaining scene work when %s starts loading during the tick", (initiator) => {
    const order: string[] = [];
    let ready = true;
    const world = new World({
      seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry(),
      canTickScene: () => ready,
      onPhysics: () => { order.push("physics"); },
    });
    world.setGameInstance(new GameInstance({ classId: "GameInstance", hooks: { onTick: () => {
      order.push("gi");
      if (initiator === "gi") ready = false;
    } } }));
    const first = world.createActor({ classId: "Actor", hooks: { onTick: () => {
      order.push("actor");
      ready = false;
    } } });
    first.attachComponent(world.createComponent({ classId: "ActorComponent", hooks: { onTick: () => { order.push("component"); } } }));
    world.spawnActorNow(first);
    world.spawnActorNow(world.createActor({ classId: "Actor", hooks: { onTick: () => { order.push("sibling"); } } }));
    world.tick();
    expect(order).toEqual(initiator === "gi" ? ["gi"] : ["gi", "actor"]);
  });

  it("cleans up only the owned actor when a later actor reuses its guid", () => {
    const world = createTestWorld();
    const old = world.createActor({ classId: "Actor", guid: "same" });
    world.spawnActorNow(old);
    world.destroyActorInstance(old);
    world.flushPending();
    const replacement = world.createActor({ classId: "Actor", guid: "same" });
    world.spawnActor(replacement);
    world.flushPending();
    // A stale cleanup of the predecessor never reaches its successor.
    world.destroyActorInstance(old);
    world.flushPending();
    expect(old.destroyed).toBe(true);
    expect(world.getActors()).toEqual([replacement]);
    expect(replacement.destroyed).toBe(false);
    expect(world.findActor("same")).toBe(replacement);
  });

  it("makes committed actors discoverable before creation hooks and removes them before destruction hooks", () => {
    const world = createTestWorld();
    const visibility: Array<[string, boolean]> = [];
    const actor = world.createActor({
      classId: "Actor",
      guid: "actor",
      hooks: {
        onCreation: (self) => {
          visibility.push(["actor-created", world.findActor(self.guid) === self]);
        },
        onDestroyed: (self) => {
          visibility.push(["actor-destroyed", world.findActor(self.guid) !== undefined]);
        },
      },
    });
    actor.attachComponent(world.createComponent({
      classId: "ActorComponent",
      hooks: {
        onCreation: () => {
          visibility.push(["component-created", world.findActor("actor") === actor]);
        },
        onDestroyed: () => {
          visibility.push(["component-destroyed", world.findActor("actor") !== undefined]);
        },
      },
    }));
    world.spawnActor(actor);
    expect(world.findActor("actor")).toBeUndefined();
    world.flushPending();
    expect(world.findActor("actor")).toBe(actor);
    world.destroyActor("actor");
    expect(world.findActor("actor")).toBe(actor);
    world.flushPending();
    expect(world.findActor("actor")).toBeUndefined();
    expect(visibility).toEqual([
      ["actor-created", true],
      ["component-created", true],
      ["component-destroyed", false],
      ["actor-destroyed", false],
    ]);
  });

  it("refuses to spawn an actor whose guid a live actor holds, until its destruction commits", () => {
    const world = createTestWorld();
    const events: string[] = [];
    const first = world.createActor({ classId: "Actor", guid: "shared" });
    world.spawnActorNow(first);
    const second = world.createActor({ classId: "Enemy", guid: "shared", hooks: { onCreation: () => { events.push("created"); } } });
    expect(() => world.spawnActorNow(second)).toThrow(DuplicateActorGuidError);
    expect(() => world.spawnActor(second)).toThrow('Cannot spawn Enemy actor "shared": a live Actor actor already uses this guid.');
    // A queued destruction keeps the predecessor live until it commits.
    world.destroyActor("shared");
    expect(() => world.spawnActorNow(second)).toThrow(DuplicateActorGuidError);
    world.flushPending();
    expect(events).toEqual([]);
    world.spawnActorNow(second);
    expect(events).toEqual(["created"]);
    expect(world.getActors()).toEqual([second]);
    expect(world.findActor("shared")).toBe(second);
  });

  it("reserves a queued spawn's guid until the spawn commits or is cancelled", () => {
    const world = createTestWorld();
    const queued = world.createActor({ classId: "Actor", guid: "queued" });
    world.spawnActor(queued);
    const rival = world.createActor({ classId: "Actor", guid: "queued" });
    expect(() => world.spawnActorNow(rival)).toThrow(DuplicateActorGuidError);
    expect(() => world.spawnActor(rival)).toThrow(DuplicateActorGuidError);
    world.destroyActorInstance(queued);
    world.spawnActor(rival);
    world.flushPending();
    expect(world.getActors()).toEqual([rival]);
    expect(queued.destroyed).toBe(true);
  });

  it("keeps a ready SceneLayer ticking when Game Instance starts loading the world scene", () => {
    const events: string[] = [];
    let worldReady = true;
    const world = new World({
      seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry(),
      canTickActor: (actor) => actor.sceneLayerId === "global" || worldReady,
    });
    world.setGameInstance(new GameInstance({ classId: "GameInstance", hooks: { onTick: () => {
      events.push("gi");
      worldReady = false;
    } } }));
    for (const [name, layer] of [["world", null], ["overlay", "global"]] as const) {
      const actor = world.createActor({ classId: "Actor", sceneLayerId: layer,
        hooks: { onTick: () => { events.push(name); } } });
      actor.attachComponent(world.createComponent({ classId: "ActorComponent",
        hooks: { onTick: () => { events.push(`${name}-component`); } } }));
      world.spawnActorNow(actor);
    }
    world.tick();
    world.tick();
    expect(events).toEqual(["gi", "overlay", "overlay-component", "gi", "overlay", "overlay-component"]);
  });

  it("rechecks an owner's readiness between component callbacks without blocking a ready sibling layer", () => {
    const events: string[] = [];
    const ready = new Set(["first", "second"]);
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry(),
      canTickActor: (actor) => ready.has(actor.sceneLayerId!) });
    for (const layer of ["first", "second"]) {
      const actor = world.createActor({ classId: "Actor", sceneLayerId: layer });
      for (const index of [1, 2]) actor.attachComponent(world.createComponent({ classId: "ActorComponent",
        hooks: { onTick: () => {
          events.push(`${layer}-${index}`);
          if (layer === "first") ready.delete(layer);
        } } }));
      world.spawnActorNow(actor);
    }
    world.tick();
    expect(events).toEqual(["first-1", "second-1", "second-2"]);
  });

  it("discards cancelled actor preparation without running queued lifecycle hooks", () => {
    const world = createTestWorld();
    const events: string[] = [];
    const actor = world.createActor({ classId: "Actor", hooks: {
      onCreation: () => { events.push("created"); },
      onDestroyed: () => { events.push("destroyed"); },
    } });
    const component = world.createComponent({ classId: "ActorComponent", hooks: {
      onCreation: () => { events.push("component-created"); },
      onDestroyed: () => { events.push("component-destroyed"); },
    } });
    actor.attachComponent(component);
    world.spawnActor(actor);
    world.destroyActorInstance(actor);
    world.flushPending();
    expect(events).toEqual([]);
    expect(world.getActors()).toHaveLength(0);
    expect(actor.destroyed).toBe(true);
    expect(component.owner).toBeNull();
    expect(world.findActor(actor.guid)).toBeUndefined();
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

  it("allows destruction hooks to replace an actor with the same guid without deleting the replacement", () => {
    const world = createTestWorld();
    let replacement: ReturnType<typeof world.createActor> | undefined;
    const original = world.createActor({ classId: "Actor", guid: "shared", hooks: {
      onDestroyed: () => {
        replacement = world.createActor({ classId: "Actor", guid: "shared" });
        world.spawnActorNow(replacement);
        world.destroyActorInstance(original);
        world.flushPending();
      },
    } });
    world.spawnActorNow(original);
    world.destroyActorInstance(original);
    world.flushPending();
    expect(world.getActors()).toEqual([replacement]);
    expect(replacement?.destroyed).toBe(false);
    expect(replacement?.spawnIndex).toBe(0);
    expect(world.findActor("shared")).toBe(replacement);
  });

  it("keeps a SceneLayer and Actor recreated by departing destruction hooks", () => {
    const world = createTestWorld();
    const layer = world.createSceneLayer({ guid: "layer", assetGuid: "overlay", zOrder: 0 });
    let replacementLayer: ReturnType<typeof world.createSceneLayer> | undefined;
    let replacementActor: ReturnType<typeof world.createActor> | undefined;
    const actor = world.createActor({ classId: "Actor", guid: "actor", sceneLayerId: layer.guid, hooks: {
      onDestroyed: () => {
        replacementLayer = world.createSceneLayer({ guid: "layer", assetGuid: "overlay", zOrder: 0 });
        replacementActor = world.createActor({ classId: "Actor", guid: "actor", sceneLayerId: "layer" });
        world.spawnActorNow(replacementActor);
      },
    } });
    world.spawnActorNow(actor);
    world.destroySceneLayer(layer.guid);
    expect(layer.destroyed).toBe(true);
    expect(actor.destroyed).toBe(true);
    expect(world.getSceneLayers()).toEqual([replacementLayer]);
    expect(world.getActors()).toEqual([replacementActor]);
    expect(replacementActor?.destroyed).toBe(false);
    expect(world.findActor("actor")).toBe(replacementActor);
  });

  it("removes interleaved layer actors one at a time with dense spawn indices, including re-entrant removals", () => {
    const world = createTestWorld();
    const events: string[] = [];
    const order = () => world.getActors().map((actor) => actor.guid).join(",");
    const indexed = () => world.getActors().map((actor) => `${actor.guid}@${actor.spawnIndex}`).join(",");
    const spawn = (guid: string, sceneLayerId: string | null) => {
      const actor = world.createActor({ classId: "Actor", guid, sceneLayerId, hooks: {
        onDestroyed: () => { events.push(guid === "a1" ? `${guid}:${indexed()}` : `${guid}:${order()}`); },
      } });
      world.spawnActorNow(actor);
      return actor;
    };
    world.createSceneLayer({ guid: "L", assetGuid: "overlay", zOrder: 0 });
    world.createSceneLayer({ guid: "M", assetGuid: "overlay", zOrder: 1 });
    spawn("a0", null);
    const a1 = spawn("a1", "L");
    spawn("a2", null);
    spawn("a3", "L");
    spawn("a4", "M");
    spawn("a5", "L");
    spawn("a6", null);
    // Removes a later actor while a1's own removal is still settling.
    a1.attachComponent(world.createComponent({ classId: "ActorComponent", hooks: {
      onDestroyed: () => {
        events.push("a1-component");
        world.destroySceneLayer("M");
      },
    } }));
    world.destroySceneLayer("L");
    expect(events).toEqual([
      "a1-component",
      "a4:a0,a2,a3,a5,a6",
      "a1:a0@0,a2@1,a3@2,a5@3,a6@4",
      "a3:a0,a2,a5,a6",
      "a5:a0,a2,a6",
    ]);
    expect(indexed()).toBe("a0@0,a2@1,a6@2");
  });

  it("ticks exactly the actors and components present when each phase reached them", () => {
    const world = createTestWorld();
    const ticks: string[] = [];
    let firstTick = true;
    world.createSceneLayer({ guid: "layer", assetGuid: "overlay", zOrder: 0 });
    const actor = (guid: string, sceneLayerId: string | null = null, onTick?: () => void) => world.createActor({
      classId: "Actor", guid, sceneLayerId, hooks: { onTick: () => { ticks.push(guid); if (firstTick) onTick?.(); } },
    });
    const component = (guid: string, onTick?: () => void) => world.createComponent({
      classId: "ActorComponent", guid, hooks: { onTick: () => { ticks.push(guid); if (firstTick) onTick?.(); } },
    });
    // Mid-phase: a synchronous removal of a later actor and a committed spawn.
    const first = actor("first", null, () => {
      world.destroySceneLayer("layer");
      world.spawnActor(actor("late"));
      world.flushPending();
    });
    const second = actor("second");
    // Mid-phase: attaches to the ticking actor and to one the phase has not reached.
    first.attachComponent(component("first-c", () => {
      first.attachComponent(component("first-added"));
      second.attachComponent(component("second-added"));
    }));
    world.spawnActorNow(first);
    world.spawnActorNow(actor("overlay", "layer"));
    world.spawnActorNow(second);
    world.spawnActorNow(actor("third"));
    world.tick();
    firstTick = false;
    expect(ticks).toEqual(["first", "second", "third", "first-c", "second-added"]);
    expect(world.getActors().map((entry) => `${entry.guid}@${entry.spawnIndex}`))
      .toEqual(["first@0", "second@1", "third@2", "late@3"]);
    ticks.length = 0;
    world.tick();
    expect(ticks).toEqual(["first", "second", "third", "late", "first-c", "first-added", "second-added"]);
  });

  it("marks the structural revision for direct actor parent/name map writes", () => {
    const world = createTestWorld();
    const actor = world.createActor({ classId: "Actor", variables: { name: "Hero" } });
    world.spawnActorNow(actor);
    const revision = () => world.structuralRevision;
    let before = revision();
    actor.variables.set("parentId", "root");
    expect(revision()).toBeGreaterThan(before);
    before = revision();
    actor.variables.set("parentId", "root");
    actor.variables.set("health", 3);
    expect(revision()).toBe(before);
    actor.variables.delete("name");
    expect(revision()).toBeGreaterThan(before);
    before = revision();
    actor.variables.clear();
    expect(revision()).toBeGreaterThan(before);
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

function subsystemRegistry(
  classes: ReadonlyArray<[id: string, parent: string]>,
): ClassRegistry {
  const registry = new ClassRegistry();
  for (const [id, parentClassId] of classes) {
    const result = registry.register({
      id,
      parentClassId,
      kind: "object",
      variables: [],
      implementedInterfaces: [],
    });
    if (!result.ok) throw new Error(result.error);
  }
  return registry;
}

function recordingGameInstance(events: string[]): GameInstance {
  return new GameInstance({
    classId: "GameInstance",
    guid: "gi",
    hooks: {
      onCreation: () => events.push("gi:init"),
      onTick: () => events.push("gi:tick"),
      onGameEnd: () => events.push("gi:end"),
      onSceneStartLoading: (_self, name) => events.push(`gi:start:${name}`),
      onSceneFinishLoading: (_self, name) => events.push(`gi:finish:${name}`),
      onFirstSceneLoaded: (_self, name) => events.push(`gi:first:${name}`),
      onSceneExit: (_self, name) => events.push(`gi:exit:${name}`),
    },
  });
}

function recordingGameSubsystem(
  world: World,
  classId: string,
  events: string[],
): GameSubsystem {
  return world.createGameSubsystem({
    classId,
    hooks: {
      onCreation: () => events.push(`${classId}:init`),
      onTick: () => events.push(`${classId}:tick`),
      onGameEnd: () => events.push(`${classId}:end`),
      onSceneStartLoading: (_self, name) => events.push(`${classId}:start:${name}`),
      onSceneFinishLoading: (_self, name) => events.push(`${classId}:finish:${name}`),
      onFirstSceneLoaded: (_self, name) => events.push(`${classId}:first:${name}`),
      onSceneExit: (_self, name) => events.push(`${classId}:exit:${name}`),
    },
  });
}

function recordingSceneSubsystemHooks(
  events: string[],
): (classId: string) => SceneSubsystemHooks {
  return (classId) => ({
    onCreation: () => events.push(`${classId}:init`),
    onTick: () => events.push(`${classId}:tick`),
    onEnd: () => events.push(`${classId}:end`),
    onSceneLoaded: (_self, name) => events.push(`${classId}:loaded:${name}`),
    onStreamedSceneLoaded: (_self, actor, scene) =>
      events.push(`${classId}:streamLoaded:${actor.guid}:${scene.guid}`),
    onStreamedSceneUnloaded: (_self, actor, scene) =>
      events.push(`${classId}:streamUnloaded:${actor.guid}:${scene.guid}`),
    onSceneLayerAdded: (_self, layer) => events.push(`${classId}:layerAdded:${layer.guid}`),
    onSceneLayerRemoved: (_self, layer) => events.push(`${classId}:layerRemoved:${layer.guid}`),
    onSceneActorSpawned: (_self, actor) => events.push(`${classId}:spawned:${actor.guid}`),
    onSceneActorDestroyed: (_self, actor) => events.push(`${classId}:destroyed:${actor.guid}`),
  });
}

const guids = (subsystems: readonly Subsystem[]) =>
  subsystems.map((subsystem) => subsystem.guid);

describe("World subsystems", () => {
  it("wraps the Game Instance with GameSubsystems and runs SceneSubsystems inside the main scene", () => {
    const events: string[] = [];
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: new ClassRegistry(),
      sceneSubsystemHooksFor: recordingSceneSubsystemHooks(events),
    });
    world.setGameInstance(recordingGameInstance(events));
    world.setGameSubsystems([
      recordingGameSubsystem(world, "Zeta", events),
      recordingGameSubsystem(world, "Alpha", events),
    ]);
    world.setSceneSubsystemClasses(["Weather", "Music"]);
    world.start();
    world.beginSceneLoad("L1");
    world.createScene({
      assetGuid: "scene-1",
      sceneName: "L1",
      hooks: { onDestroyed: () => events.push("scene:destroyed") },
    });
    world.spawnActorNow(world.createActor({
      classId: "Actor",
      guid: "hero",
      hooks: {
        onCreation: () => events.push("hero:beginPlay"),
        onTick: () => events.push("hero:tick"),
      },
    }));
    world.finishSceneLoad("L1");
    world.tick();
    world.end();
    expect(events).toEqual([
      "Alpha:init", "Zeta:init", "gi:init",
      "gi:start:L1", "Alpha:start:L1", "Zeta:start:L1",
      "Music:init", "Weather:init",
      "Music:spawned:hero", "Weather:spawned:hero", "hero:beginPlay",
      "gi:finish:L1", "Alpha:finish:L1", "Zeta:finish:L1",
      "gi:first:L1", "Alpha:first:L1", "Zeta:first:L1",
      "Music:loaded:L1", "Weather:loaded:L1",
      "gi:tick", "Alpha:tick", "Zeta:tick", "Music:tick", "Weather:tick", "hero:tick",
      "Weather:end", "Music:end", "scene:destroyed",
      "gi:exit:L1", "Alpha:exit:L1", "Zeta:exit:L1",
      "gi:end", "Zeta:end", "Alpha:end",
    ]);
    // Ended subsystems never tick or end again.
    const before = events.length;
    world.end();
    world.tick();
    expect(
      events.slice(before).filter((event) => /^(Alpha|Zeta|Music|Weather):/.test(event)),
    ).toEqual([]);
  });

  it("ends SceneSubsystems on every main-scene exit and creates fresh instances per Scene", () => {
    const events: string[] = [];
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: subsystemRegistry([["Weather", "SceneSubsystem"]]),
      sceneSubsystemHooksFor: () => ({
        onCreation: (self) => events.push(`init:${self.guid}`),
        onEnd: (self) => events.push(`end:${self.guid}`),
      }),
    });
    world.setSceneSubsystemClasses(["Weather"]);
    const sceneHooks = (label: string) => ({
      onDestroyed: () => events.push(`destroyed:${label}`),
    });

    world.beginSceneLoad("L1");
    world.createScene({ assetGuid: "scene-1", sceneName: "L1", hooks: sceneHooks("first") });
    world.finishSceneLoad("L1");
    const [first] = world.findSubsystems("Weather");
    world.exitActiveScene();
    expect(world.findSubsystems("Weather")).toEqual([]);
    expect(world.getSceneSubsystems()).toEqual([]);

    // Same-scene reload, then a direct replacement without exitActiveScene.
    world.beginSceneLoad("L1");
    world.createScene({ assetGuid: "scene-1", sceneName: "L1", hooks: sceneHooks("second") });
    const third = world.createScene({ assetGuid: "scene-2", sceneName: "L2", hooks: sceneHooks("third") });
    const live = world.getSceneSubsystems();
    world.end();

    expect(events).toEqual([
      "init:scene-subsystem:Weather:1",
      "end:scene-subsystem:Weather:1", "destroyed:first",
      "init:scene-subsystem:Weather:2",
      "end:scene-subsystem:Weather:2", "destroyed:second",
      "init:scene-subsystem:Weather:3",
      "end:scene-subsystem:Weather:3", "destroyed:third",
    ]);
    expect(first?.destroyed).toBe(true);
    expect(live.map((subsystem) => subsystem.scene)).toEqual([third]);
    expect(world.getSceneSubsystems()).toEqual([]);
  });

  it("keeps the replacement scene when a SceneSubsystem's On End changes scene re-entrantly", () => {
    const events: string[] = [];
    const world: World = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: subsystemRegistry([["Weather", "SceneSubsystem"]]),
      sceneSubsystemHooksFor: () => ({
        onCreation: (self) => events.push(`init:${self.guid}`),
        onEnd: (self) => {
          events.push(`end:${self.guid}`);
          if (self.scene.assetGuid === "scene-a") {
            world.createScene({ assetGuid: "scene-b", sceneName: "B" });
          }
        },
      }),
    });
    world.setSceneSubsystemClasses(["Weather"]);
    world.createScene({ assetGuid: "scene-a", sceneName: "A" });

    world.exitActiveScene();
    const replacement = world.currentScene;
    expect(replacement?.assetGuid).toBe("scene-b");
    expect(replacement?.destroyed).toBe(false);
    expect(guids(world.findSubsystems("Weather"))).toEqual(["scene-subsystem:Weather:2"]);

    // A re-entrant scene installed during createScene's own teardown is retired too.
    world.createScene({ assetGuid: "scene-a", sceneName: "A" });
    world.createScene({ assetGuid: "scene-c", sceneName: "C" });
    expect(world.currentScene?.assetGuid).toBe("scene-c");
    expect(guids(world.getSceneSubsystems())).toEqual(["scene-subsystem:Weather:5"]);
    expect(events).toEqual([
      "init:scene-subsystem:Weather:1",
      "end:scene-subsystem:Weather:1", "init:scene-subsystem:Weather:2",
      "end:scene-subsystem:Weather:2", "init:scene-subsystem:Weather:3",
      "end:scene-subsystem:Weather:3", "init:scene-subsystem:Weather:4",
      "end:scene-subsystem:Weather:4", "init:scene-subsystem:Weather:5",
    ]);
  });

  it("rejects installing GameSubsystems after start, which would reorder On Init", () => {
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
    world.start();
    expect(() => world.setGameSubsystems([])).toThrow(/before World\.start/);
  });

  it("announces world actors and SceneLayers to live SceneSubsystems and pairs removals with arrivals", () => {
    const events: string[] = [];
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: new ClassRegistry(),
      sceneSubsystemHooksFor: recordingSceneSubsystemHooks(events),
    });
    world.setSceneSubsystemClasses(["Weather"]);
    // Present before the Scene: never announced, so never reported as removed.
    world.spawnActorNow(world.createActor({ classId: "Actor", guid: "early" }));
    world.createSceneLayer({ guid: "hud", assetGuid: "hud-asset", zOrder: 1 });
    world.createScene({ assetGuid: "scene-1", sceneName: "L1" });
    events.length = 0;

    world.spawnActorNow(world.createActor({
      classId: "Actor",
      guid: "hero",
      hooks: { onCreation: () => events.push("hero:beginPlay") },
    }));
    world.createSceneLayer({ guid: "menu", assetGuid: "menu-asset", zOrder: 2 });
    world.spawnActorNow(world.createActor({ classId: "SceneLayerActor", guid: "button", sceneLayerId: "menu" }));
    const streamer = world.createActor({ classId: "SceneStreamingActor", guid: "streamer" });
    if (!(streamer instanceof SceneStreamingActor)) throw new Error("expected a SceneStreamingActor");
    world.spawnActorNow(streamer);
    const streamed = new Scene({ guid: "stream:streamer:1", assetGuid: "sub", sceneName: "Sub" });
    world.notifyStreamedSceneLoaded(streamer, streamed);
    world.notifyStreamedSceneUnloaded(streamer, streamed);
    world.destroyActor("hero");
    world.destroyActor("early");
    world.flushPending();
    world.destroySceneLayer("menu");
    world.destroySceneLayer("hud");
    world.exitActiveScene();
    // After On End: no per-actor or stream notifications during teardown.
    world.destroyActor("streamer");
    world.flushPending();
    world.notifyStreamedSceneUnloaded(streamer, streamed);

    expect(events).toEqual([
      "Weather:spawned:hero", "hero:beginPlay",
      "Weather:layerAdded:menu",
      "Weather:spawned:streamer",
      "Weather:streamLoaded:streamer:stream:streamer:1",
      "Weather:streamUnloaded:streamer:stream:streamer:1",
      "Weather:destroyed:hero",
      "Weather:layerRemoved:menu",
      "Weather:end",
    ]);
  });

  it("announces a world actor its host held back once, when it enters play", () => {
    const events: string[] = [];
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: new ClassRegistry(),
      sceneSubsystemHooksFor: recordingSceneSubsystemHooks(events),
    });
    world.setSceneSubsystemClasses(["Weather"]);
    world.spawnActorNow(world.createActor({ classId: "Actor", guid: "held" }));
    world.createScene({ assetGuid: "scene-1", sceneName: "L1" });
    world.createSceneLayer({ guid: "menu", assetGuid: "menu-asset", zOrder: 1 });
    world.spawnActorNow(world.createActor({ classId: "SceneLayerActor", guid: "button", sceneLayerId: "menu" }));
    events.length = 0;

    world.notifyActorEnteringPlay(world.findActor("held")!);
    world.notifyActorEnteringPlay(world.findActor("held")!);
    world.notifyActorEnteringPlay(world.findActor("button")!);
    world.destroyActor("held");
    world.flushPending();

    expect(events).toEqual(["Weather:spawned:held", "Weather:destroyed:held"]);
  });

  it("stops a scene's Finish Loading announcement once a handler loads another scene", () => {
    const events: string[] = [];
    const world: World = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: new ClassRegistry(),
      sceneSubsystemHooksFor: recordingSceneSubsystemHooks(events),
    });
    world.setGameInstance(new GameInstance({
      classId: "GameInstance",
      hooks: {
        onSceneFinishLoading: (_self, name) => {
          events.push(`gi:finish:${name}`);
          if (name !== "Intro") return;
          world.exitActiveScene();
          world.beginSceneLoad("Menu");
          world.createScene({ assetGuid: "menu", sceneName: "Menu" });
          world.finishSceneLoad("Menu");
        },
        onFirstSceneLoaded: (_self, name) => events.push(`gi:first:${name}`),
      },
    }));
    world.setGameSubsystems([recordingGameSubsystem(world, "Svc", events)]);
    world.setSceneSubsystemClasses(["Rules"]);
    world.start();
    world.beginSceneLoad("Intro");
    world.createScene({ assetGuid: "intro", sceneName: "Intro" });
    events.length = 0;

    world.finishSceneLoad("Intro");

    // Nothing stale about Intro reaches Svc or the replacement Rules afterwards.
    expect(events).toEqual([
      "gi:finish:Intro",
      "Rules:end", "Svc:exit:Intro", "Svc:start:Menu", "Rules:init",
      "gi:finish:Menu", "Svc:finish:Menu", "gi:first:Menu", "Svc:first:Menu",
      "Rules:loaded:Menu",
    ]);
  });

  it("gates SceneSubsystem ticks like actors while GameSubsystems tick during preparation", () => {
    const events: string[] = [];
    let sceneReady = false;
    const blocked = new Set(["Music"]);
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: new ClassRegistry(),
      canTickScene: () => sceneReady,
      canTickSceneSubsystem: (subsystem) => !blocked.has(subsystem.classId),
      sceneSubsystemHooksFor: (classId) => ({
        onTick: () => {
          events.push(classId);
          if (classId === "Music") sceneReady = false;
        },
      }),
    });
    world.setGameSubsystems([
      world.createGameSubsystem({ classId: "Save", hooks: { onTick: () => { events.push("Save"); } } }),
    ]);
    world.setSceneSubsystemClasses(["Music", "Weather"]);
    world.createScene({ assetGuid: "scene-1", sceneName: "L1" });
    world.tick();
    expect(events).toEqual(["Save"]);
    sceneReady = true;
    world.tick();
    expect(events).toEqual(["Save", "Save", "Weather"]);
    // Music drops readiness mid-phase, so Weather waits like a later actor.
    blocked.clear();
    world.tick();
    expect(events).toEqual(["Save", "Save", "Weather", "Save", "Music"]);
  });

  it("applies class defaults and fixed guids without consuming the World guid factory", () => {
    const registry = new ClassRegistry();
    registry.register({
      id: "Inventory",
      parentClassId: "GameSubsystem",
      kind: "object",
      variables: [
        { name: "slots", type: "int", defaultValue: 8 },
        { name: "items", type: "string", container: "array", defaultValue: ["key"] },
      ],
      implementedInterfaces: ["iface-save"],
    });
    registry.register({
      id: "Weather",
      parentClassId: "SceneSubsystem",
      kind: "object",
      variables: [{ name: "rain", type: "float", defaultValue: 0.5 }],
      implementedInterfaces: ["iface-weather"],
    });
    let n = 0;
    const world = new World({
      seed: 1,
      dt: 1 / 60,
      classRegistry: registry,
      guidFactory: () => `id-${++n}`,
    });
    const inventory = world.createGameSubsystem({ classId: "Inventory", variables: { slots: 12 } });
    world.setSceneSubsystemClasses(["Weather"]);
    const scene = world.createScene({ assetGuid: "scene-1", sceneName: "L1" });
    const actor = world.createActor({ classId: "Actor" });
    const [weather] = world.getSceneSubsystems();

    expect(inventory.guid).toBe("subsystem:Inventory");
    expect(inventory.getVariable("slots")).toBe(12);
    expect(inventory.getVariable("items")).toEqual(["key"]);
    expect(inventory.implementedInterfaces).toEqual(["iface-save"]);
    expect(weather?.guid).toBe("scene-subsystem:Weather:1");
    expect(weather?.getVariable("rain")).toBe(0.5);
    expect(weather?.implementedInterfaces).toEqual(["iface-weather"]);
    expect([scene.guid, actor.guid]).toEqual(["id-1", "id-2"]);
  });

  it("resolves Get by ancestry in class-id order and skips ended subsystems during teardown", () => {
    const registry = subsystemRegistry([
      ["Audio", "GameSubsystem"],
      ["SfxAudio", "Audio"],
      ["MusicAudio", "Audio"],
      ["Weather", "SceneSubsystem"],
    ]);
    const world = new World({ seed: 1, dt: 1 / 60, classRegistry: registry });
    const duringEnd: Record<string, string[]> = {};
    world.setGameInstance(new GameInstance({
      classId: "GameInstance",
      hooks: { onGameEnd: () => { duringEnd.gi = guids(world.findSubsystems("Audio")); } },
    }));
    world.setGameSubsystems(["SfxAudio", "MusicAudio"].map((classId) =>
      world.createGameSubsystem({
        classId,
        hooks: { onGameEnd: () => { duringEnd[classId] = guids(world.findSubsystems("Audio")); } },
      })));
    world.setSceneSubsystemClasses(["Weather"]);
    world.start();
    expect(world.findSubsystems("Weather")).toEqual([]);
    world.createScene({ assetGuid: "scene-1", sceneName: "L1" });

    expect(guids(world.findSubsystems("Audio"))).toEqual(["subsystem:MusicAudio", "subsystem:SfxAudio"]);
    expect(guids(world.findSubsystems("SfxAudio"))).toEqual(["subsystem:SfxAudio"]);
    expect(guids(world.findSubsystems("Weather"))).toEqual(["scene-subsystem:Weather:1"]);
    expect(world.findSubsystems("GameInstance")).toEqual([]);
    world.end();
    expect(duringEnd).toEqual({
      gi: ["subsystem:MusicAudio", "subsystem:SfxAudio"],
      SfxAudio: ["subsystem:MusicAudio"],
      MusicAudio: [],
    });
    expect(world.findSubsystems("Audio")).toEqual([]);
    expect(world.findSubsystems("Weather")).toEqual([]);
  });

  it("adds the subsystems snapshot key only when subsystems exist", () => {
    const plain = createTestWorld();
    expect(Object.keys(createWorldSnapshot(plain))).toEqual([
      "tickIndex", "dt", "gameInstance", "actors",
    ]);
    const world = createTestWorld();
    world.setGameSubsystems([
      world.createGameSubsystem({ classId: "Save", variables: { slot: 2, autosave: true } }),
    ]);
    world.setSceneSubsystemClasses(["Weather"]);
    world.createScene({ assetGuid: "scene-1", sceneName: "L1" });
    const snapshot = createWorldSnapshot(world);
    expect(Object.keys(snapshot)).toEqual([
      "tickIndex", "dt", "gameInstance", "subsystems", "actors",
    ]);
    expect(snapshot.subsystems).toEqual([
      { guid: "subsystem:Save", classId: "Save", variables: { autosave: true, slot: 2 } },
      { guid: "scene-subsystem:Weather:1", classId: "Weather", variables: {} },
    ]);
  });
});
