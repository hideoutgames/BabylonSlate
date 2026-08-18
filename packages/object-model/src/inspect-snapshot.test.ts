import { describe, expect, it } from "vitest";
import { ClassRegistry } from "./class-registry";
import { Actor, BObject, GameInstance } from "./objects";
import { World } from "./world";
import {
  createDebugInspectSnapshot,
  sanitizeInspectValue,
} from "./inspect-snapshot";

function createInspectWorld() {
  let n = 0;
  const world = new World({
    seed: 1,
    dt: 1 / 60,
    classRegistry: new ClassRegistry(),
    guidFactory: () => `id-${++n}`,
  });
  world.setGameInstance(
    new GameInstance({
      classId: "GameInstance",
      guid: "gi",
      variables: { score: 3 },
    }),
  );
  return world;
}

describe("createDebugInspectSnapshot", () => {
  it("lists Game Instance, parented actors, and components as a parentId tree", () => {
    const world = createInspectWorld();
    const parent = world.createActor({
      guid: "hero",
      classId: "Actor",
      variables: { name: "Hero", parentId: null, health: 10 },
    });
    parent.attachComponent(
      world.createComponent({
        guid: "mesh-1",
        classId: "MeshComponent",
        variables: { meshKind: "box" },
      }),
    );
    const child = world.createActor({
      guid: "sword",
      classId: "Actor",
      variables: { name: "Sword", parentId: "hero" },
    });
    world.spawnActorNow(parent);
    world.spawnActorNow(child);
    world.tick();

    const snapshot = createDebugInspectSnapshot(world);
    expect(snapshot.tickIndex).toBe(1);
    expect(snapshot.nodes.map((node) => node.id)).toEqual([
      "gi",
      "hero",
      "mesh-1",
      "sword",
    ]);
    expect(snapshot.nodes[0]).toMatchObject({
      kind: "gameInstance",
      label: "GameInstance",
      classId: "GameInstance",
      parentId: null,
      variables: { score: 3 },
    });
    expect(snapshot.nodes[1]).toMatchObject({
      kind: "actor",
      label: "Hero",
      classId: "Actor",
      parentId: null,
      variables: { health: 10, name: "Hero", parentId: null },
    });
    expect(snapshot.nodes[1]?.transform?.position).toEqual([0, 0, 0]);
    expect(snapshot.nodes[2]).toMatchObject({
      kind: "component",
      label: "MeshComponent",
      classId: "MeshComponent",
      parentId: "hero",
      variables: { meshKind: "box" },
    });
    expect(snapshot.nodes[3]).toMatchObject({
      kind: "actor",
      label: "Sword",
      parentId: "hero",
    });
  });

  it("falls back to classId when an actor has no name", () => {
    const world = createInspectWorld();
    const actor = world.createActor({
      guid: "anon",
      classId: "Actor",
    });
    world.spawnActorNow(actor);
    const snapshot = createDebugInspectSnapshot(world);
    const node = snapshot.nodes.find((entry) => entry.id === "anon");
    expect(node?.label).toBe("Actor");
  });

  it("sanitizes object references and circular values", () => {
    const world = createInspectWorld();
    const other = new BObject({ classId: "Actor", guid: "other" });
    const cycle: Record<string, unknown> = { n: 1 };
    cycle.self = cycle;
    const actor = world.createActor({
      guid: "holder",
      classId: "Actor",
      variables: {
        name: "Holder",
        target: other,
        loop: cycle,
      },
    });
    world.spawnActorNow(actor);
    const snapshot = createDebugInspectSnapshot(world);
    const node = snapshot.nodes.find((entry) => entry.id === "holder");
    expect(node?.variables.target).toEqual({ guid: "other", classId: "Actor" });
    expect(typeof node?.variables.loop).toBe("string");
    expect(JSON.stringify(snapshot.nodes)).toBeTypeOf("string");
  });
});

describe("sanitizeInspectValue", () => {
  it("keeps primitives and converts BObject refs", () => {
    expect(sanitizeInspectValue(7)).toBe(7);
    expect(sanitizeInspectValue("ok")).toBe("ok");
    expect(sanitizeInspectValue(true)).toBe(true);
    expect(sanitizeInspectValue(null)).toBe(null);
    expect(sanitizeInspectValue(undefined)).toBe(null);
    expect(
      sanitizeInspectValue(new Actor({ classId: "Actor", guid: "a1" })),
    ).toEqual({ guid: "a1", classId: "Actor" });
  });
});
