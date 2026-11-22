import { describe, expect, it, vi } from "vitest";
import { functionModuleLoader } from "./function-module-loader";
import { ClassRegistry, World, type Actor, type ActorComponent } from "@haptic/object-model";
import { ScriptHost } from "./script-host";
import type { ScriptHostServices } from "./script-host-services";

/** Hero ← SuperHero ← MegaHero and Villain actors; Health ← Armor components and an unrelated Shield. */
function fixture() {
  const classRegistry = new ClassRegistry();
  const define = (id: string, parentClassId: string, kind: "actor" | "component") =>
    expect(classRegistry.register({ id, parentClassId, kind, variables: [], implementedInterfaces: [] }).ok, id).toBe(true);
  define("Hero", "Actor", "actor");
  define("SuperHero", "Hero", "actor");
  define("MegaHero", "SuperHero", "actor");
  define("Villain", "Actor", "actor");
  define("Health", "ActorComponent", "component");
  define("Armor", "Health", "component");
  define("Shield", "ActorComponent", "component");
  const world = new World({ seed: 1, dt: 0.1, classRegistry });
  const spawn = (guid: string, classId: string, components: string[] = []): Actor => {
    const actor = world.createActor({ guid, classId });
    components.forEach((component, at) => actor.attachComponent(world.createComponent({ guid: `${guid}-${at}`, classId: component })));
    world.spawnActorNow(actor);
    return actor;
  };
  const services: ScriptHostServices = {
    moduleLoader: functionModuleLoader,
    log: () => {}, print: () => {}, destroyActor: () => {}, executeConsoleCommand: () => ({ success: true, output: "" }),
    delay: async () => {}, reportError: () => {},
    classRegistry, getActors: () => world.getActors(), getWorld: () => world,
  };
  const ctx = new ScriptHost(services).createContext(null, 0, 0);
  const guids = (objects: ReadonlyArray<Actor | ActorComponent>) => objects.map((object) => object.guid);
  return { classRegistry, world, spawn, ctx, guids, define };
}

describe("script class queries over a world", () => {
  it("returns actors of a Class and its subclasses in world order, through every kind of structure change", () => {
    const { world, spawn, ctx, guids, define } = fixture();
    spawn("v1", "Villain");
    spawn("h1", "Hero");
    spawn("m1", "MegaHero");
    spawn("s1", "SuperHero");
    spawn("h2", "Hero");
    spawn("v2", "Villain");
    expect(guids(ctx.getAllActorsOfClass("Hero"))).toEqual(["h1", "m1", "s1", "h2"]);
    expect(guids(ctx.getAllActorsOfClass("SuperHero"))).toEqual(["m1", "s1"]);
    expect(guids(ctx.getAllActorsOfClass("MegaHero"))).toEqual(["m1"]);
    expect(guids(ctx.getAllActorsOfClass("Actor"))).toEqual(["v1", "h1", "m1", "s1", "h2", "v2"]);
    expect(ctx.getActorOfClass("SuperHero")?.guid).toBe("m1");
    expect(ctx.getActorOfClass("Villain")?.guid).toBe("v1");
    for (const missing of ["", "Nobody", "Health"]) {
      expect(ctx.getAllActorsOfClass(missing)).toEqual([]);
      expect(ctx.getActorOfClass(missing)).toBeNull();
    }
    // The list handed to a script is its own: emptying it changes no later answer.
    ctx.getAllActorsOfClass("Hero").length = 0;
    expect(guids(ctx.getAllActorsOfClass("Hero"))).toEqual(["h1", "m1", "s1", "h2"]);
    // A spawn and a destroy each show in the next query.
    spawn("s2", "SuperHero");
    expect(guids(ctx.getAllActorsOfClass("Hero"))).toEqual(["h1", "m1", "s1", "h2", "s2"]);
    world.destroyActor("m1");
    world.tick();
    expect(guids(ctx.getAllActorsOfClass("Hero"))).toEqual(["h1", "s1", "h2", "s2"]);
    expect(ctx.getActorOfClass("SuperHero")?.guid).toBe("s1");
    // So does a Class registered since: the Villains' new subclass joins Villain's answer only.
    expect(guids(ctx.getAllActorsOfClass("Villain"))).toEqual(["v1", "v2"]);
    define("Boss", "Villain", "actor");
    spawn("b1", "Boss");
    expect(guids(ctx.getAllActorsOfClass("Villain"))).toEqual(["v1", "v2", "b1"]);
    expect(guids(ctx.getAllActorsOfClass("Hero"))).toEqual(["h1", "s1", "h2", "s2"]);
  });

  it("returns live components of a class and its subclasses in world then attachment order", () => {
    const { world, spawn, ctx, guids } = fixture();
    spawn("a", "Hero", ["Shield", "Armor", "Health"]);
    const b = spawn("b", "Villain", ["Health"]);
    spawn("c", "Hero", ["Shield"]);
    spawn("d", "Hero", ["Health", "Armor"]);
    expect(guids(ctx.getAllComponentsOfType("Health"))).toEqual(["a-1", "a-2", "b-0", "d-0", "d-1"]);
    expect(guids(ctx.getAllComponentsOfType("Armor"))).toEqual(["a-1", "d-1"]);
    expect(guids(ctx.getAllComponentsOfType("ActorComponent"))).toEqual(["a-0", "a-1", "a-2", "b-0", "c-0", "d-0", "d-1"]);
    expect(ctx.getFirstComponentOfType("Health")?.guid).toBe("a-1");
    expect(ctx.getFirstComponentOfType("Shield")?.guid).toBe("a-0");
    for (const missing of ["", "Nothing", "Hero"]) {
      expect(ctx.getAllComponentsOfType(missing)).toEqual([]);
      expect(ctx.getFirstComponentOfType(missing)).toBeNull();
    }
    // `destroyed` is read on every query: no structure change marks these.
    world.findActor("a")!.components[1]!.destroyed = true;
    expect(guids(ctx.getAllComponentsOfType("Health"))).toEqual(["a-2", "b-0", "d-0", "d-1"]);
    expect(ctx.getFirstComponentOfType("Armor")?.guid).toBe("d-1");
    b.destroyed = true;
    expect(guids(ctx.getAllComponentsOfType("Health"))).toEqual(["a-2", "d-0", "d-1"]);
    b.destroyed = false;
    // A component attached to a spawned actor, a new actor and a destroyed one each show in the next query.
    world.findActor("c")!.attachComponent(world.createComponent({ guid: "c-late", classId: "Armor" }));
    expect(guids(ctx.getAllComponentsOfType("Health"))).toEqual(["a-2", "b-0", "c-late", "d-0", "d-1"]);
    spawn("e", "Villain", ["Armor"]);
    world.destroyActor("d");
    world.tick();
    expect(guids(ctx.getAllComponentsOfType("Health"))).toEqual(["a-2", "b-0", "c-late", "e-0"]);
    expect(guids(ctx.getAllComponentsOfType("Armor"))).toEqual(["c-late", "e-0"]);
  });

  it("resolves a Class once per world structure, not on every query", () => {
    const { classRegistry, world, spawn, ctx } = fixture();
    for (let at = 0; at < 50; at++) {
      spawn(`hero-${at}`, at % 2 ? "Hero" : "SuperHero", ["Health", "Shield", "Armor"]);
      spawn(`villain-${at}`, "Villain", ["Shield"]);
    }
    const ancestry = vi.spyOn(classRegistry, "isA");
    // Each component of each actor is read (its `destroyed` flag) only when its actor owns a matching class.
    const villainReads = vi.fn();
    const villain = world.findActor("villain-7")!.components[0]!;
    let destroyed = false;
    Object.defineProperty(villain, "destroyed", { get: () => (villainReads(), destroyed), set: (value: boolean) => { destroyed = value; } });
    const run = () => [
      ctx.getAllActorsOfClass("Hero").length, ctx.getActorOfClass("SuperHero")?.guid,
      ctx.getAllComponentsOfType("Health").length, ctx.getFirstComponentOfType("Armor")?.guid,
    ];
    expect(run()).toEqual([50, "hero-0", 100, "hero-0-2"]);
    // The first queries ask about each distinct class once: three actor classes, three component classes, per target.
    expect(ancestry.mock.calls.length).toBeLessThanOrEqual(4 * 3);
    ancestry.mockClear();
    for (let query = 0; query < 20; query++) expect(run()).toEqual([50, "hero-0", 100, "hero-0-2"]);
    expect(ancestry).not.toHaveBeenCalled();
    expect(villainReads).not.toHaveBeenCalled();
    // A structure change resolves again, once.
    spawn("late", "Hero", ["Health"]);
    expect(run()).toEqual([51, "hero-0", 101, "hero-0-2"]);
    expect(ancestry.mock.calls.length).toBeLessThanOrEqual(4 * 3);
  });
});
