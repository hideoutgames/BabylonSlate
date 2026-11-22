import { describe, expect, it } from "vitest";
import { ClassRegistry, World, type Actor } from "@haptic/object-model";
import { overlayButtonChildren } from "./render-command-emitter";
import { findComponentByIdFromTarget } from "./script-host-helpers";
import { componentOwners, walkComponentOwners } from "./world-component-index";

const CLASS = "Probe";

function newWorld(): World {
  return new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
}

function spawn(world: World, guid: string, ...classIds: string[]): Actor {
  const actor = world.createActor({ classId: "Actor", guid });
  for (const classId of classIds) actor.attachComponent(world.createComponent({ classId }));
  return world.spawnActorNow(actor);
}

const guids = (actors: readonly Actor[]) => actors.map((actor) => actor.guid);

describe("component owner index", () => {
  it("follows spawns, attaches and destroys in world order", () => {
    const world = newWorld();
    const first = spawn(world, "first", CLASS, CLASS);
    const plain = spawn(world, "plain", "Other");
    spawn(world, "last", CLASS);
    expect(guids(componentOwners(world, CLASS))).toEqual(["first", "last"]);

    // Found by the next query, at its world position rather than in attach order.
    plain.attachComponent(world.createComponent({ classId: CLASS }));
    expect(guids(componentOwners(world, CLASS))).toEqual(["first", "plain", "last"]);

    spawn(world, "spawned", CLASS);
    world.destroyActor(first.guid);
    world.flushPending();
    expect(guids(componentOwners(world, CLASS))).toEqual(["plain", "last", "spawned"]);
    expect(guids(componentOwners(world, "Other"))).toEqual(["plain"]);
    expect(componentOwners(world, "Absent")).toEqual([]);
  });

  describe("walking owners while the visit changes the world", () => {
    // What a plain walk of the live actor list reaches, for comparison.
    const livePlainWalk = (world: World, visit: (actor: Actor) => void) => {
      for (const actor of world.getActors()) if (actor.components.some((component) => component.classId === CLASS)) visit(actor);
    };
    const changes: Record<string, (world: World, visited: Actor) => void> = {
      "spawning an owner and giving a later actor the class": (world, visited) => {
        if (visited.guid !== "a") return;
        spawn(world, "spawned", CLASS);
        world.findActor("d")!.attachComponent(world.createComponent({ classId: CLASS }));
      },
      "giving an earlier actor the class": (world, visited) => {
        if (visited.guid === "c") world.findActor("b")!.attachComponent(world.createComponent({ classId: CLASS }));
      },
      "destroying an owner ahead": (world, visited) => {
        if (visited.guid !== "a") return;
        world.destroyActor("c");
        world.flushPending();
      },
    };

    it.each(Object.keys(changes))("reaches what a plain walk does: %s", (change) => {
      const setup = () => {
        const world = newWorld();
        for (const guid of ["a", "b", "c", "d"]) spawn(world, guid, ...(guid === "a" || guid === "c" ? [CLASS] : []));
        return world;
      };
      const expected: string[] = [], reached: string[] = [];
      const plain = setup();
      livePlainWalk(plain, (actor) => { expected.push(actor.guid); changes[change]!(plain, actor); });
      const walked = setup();
      expect(walkComponentOwners(walked, CLASS, () => false, (actor) => {
        // Actors without the class are handed over only after a change, and have nothing to do.
        if (!actor.components.some((component) => component.classId === CLASS)) return;
        reached.push(actor.guid);
        changes[change]!(walked, actor);
      })).toBe(true);
      expect(reached).toEqual(expected);
    });

    it("reaches every later owner once when a visit synchronously removes actors already walked", () => {
      const world = newWorld();
      for (const guid of ["a", "b", "c", "d", "e"]) spawn(world, guid, CLASS);
      const reached: string[] = [];
      expect(walkComponentOwners(world, CLASS, () => false, (actor) => {
        reached.push(actor.guid);
        // A structural change hands the walk to the live list.
        if (actor.guid === "a") actor.attachComponent(world.createComponent({ classId: "Other" }));
        // Removing walked actors shifts the live list left under the walk.
        if (actor.guid === "c") {
          world.destroyActor("a");
          world.destroyActor("c");
          world.flushPending();
          world.getActors();
        }
      })).toBe(true);
      expect(reached).toEqual(["a", "b", "c", "d", "e"]);
    });

    it("ends at the first visit after which the session is stopped", () => {
      const world = newWorld();
      for (const guid of ["a", "b", "c"]) spawn(world, guid, CLASS);
      let stopped = false;
      const reached: string[] = [];
      expect(walkComponentOwners(world, CLASS, () => stopped, (actor) => {
        reached.push(actor.guid);
        stopped = true;
      })).toBe(false);
      expect(reached).toEqual(["a"]);
    });
  });

  describe("finding a component by id across the Scene", () => {
    const setup = () => {
      const world = newWorld();
      const scene = world.createScene({ assetGuid: "scene", sceneName: "Main" });
      const add = (guid: string, components: Array<{ guid: string; sourceId?: string }>) => {
        const actor = world.createActor({ classId: "Actor", guid });
        for (const component of components) actor.attachComponent(world.createComponent({ classId: CLASS, ...component }));
        return world.spawnActorNow(actor);
      };
      return { world, scene, add };
    };
    const find = (world: World, scene: unknown, id: string) =>
      findComponentByIdFromTarget(scene, id, undefined, world.currentScene, world);

    it("answers the first live match in world order by guid or prefab source id", () => {
      const { world, scene, add } = setup();
      const first = add("first", [{ guid: "first-mesh", sourceId: "mesh" }]);
      add("second", [{ guid: "second-mesh", sourceId: "mesh" }, { guid: "second-light" }]);
      expect(find(world, scene, "mesh")?.guid).toBe("first-mesh");
      expect(find(world, scene, "second-light")?.guid).toBe("second-light");
      expect(find(world, scene, "missing")).toBeNull();

      world.destroyActorInstance(first);
      world.flushPending();
      expect(find(world, scene, "mesh")?.guid).toBe("second-mesh");
      expect(find(world, scene, "first-mesh")).toBeNull();
    });

    it("skips a component destroyed on its own and finds one attached later to an earlier actor", () => {
      const { world, scene, add } = setup();
      const first = add("first", []);
      const second = add("second", [{ guid: "second-mesh", sourceId: "mesh" }]);
      expect(find(world, scene, "mesh")?.guid).toBe("second-mesh");
      first.attachComponent(world.createComponent({ classId: CLASS, guid: "first-mesh", sourceId: "mesh" }));
      expect(find(world, scene, "mesh")?.guid).toBe("first-mesh");
      // A destroyed flag set without a structural change still never answers.
      first.components[0]!.destroyed = true;
      expect(find(world, scene, "mesh")?.guid).toBe("second-mesh");
      expect(second.components[0]!.destroyed).toBe(false);
    });

    it("answers nothing for a Scene that is not current", () => {
      const { world, add } = setup();
      add("actor", [{ guid: "mesh" }]);
      const stale = world.currentScene!;
      world.createScene({ assetGuid: "other", sceneName: "Other" });
      expect(find(world, stale, "mesh")).toBeNull();
    });
  });

  it("lists an actor's direct children in world order whatever order they were parented in", () => {
    const world = newWorld();
    const parent = spawn(world, "parent");
    const early = spawn(world, "early");
    const late = world.spawnActorNow(world.createActor({ classId: "Actor", guid: "late", variables: { parentId: "parent" } }));
    spawn(world, "unrelated");
    early.setVariable("parentId", "parent");
    expect(guids(overlayButtonChildren(world, parent))).toEqual(["early", "late"]);
    world.destroyActorInstance(early);
    world.flushPending();
    expect(guids(overlayButtonChildren(world, parent))).toEqual([late.guid]);
    expect(overlayButtonChildren(world, late)).toEqual([]);
  });
});
