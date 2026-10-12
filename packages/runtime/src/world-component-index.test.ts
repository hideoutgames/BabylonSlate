import { describe, expect, it } from "vitest";
import { ClassRegistry, World, type Actor } from "@babylonslate/object-model";
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
});
