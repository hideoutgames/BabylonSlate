import { expect, it } from "vitest";
import { createActor } from "@babylonslate/core";
import { ClassRegistry } from "./class-registry";
import { createActorFromSerialized } from "./instantiate-scene";
import { hydrateScenePropertyReferences } from "./scene-property-values";
import { World } from "./world";

it("resolves cyclic scene references after identities exist without calling creation hooks", () => {
  const registry = new ClassRegistry();
  registry.register({ id: "MappedComponent", parentClassId: "ActorComponent", kind: "component", implementedInterfaces: [],
    variables: [{ name: "Targets", type: "object", keyTypeId: "string", container: "map", defaultValue: [] }] });
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: registry });
  let creations = 0;
  const first = createActorFromSerialized(world, createActor("first", "First", { properties: {
    target: { $sceneValue: "reference", actorId: "second" },
    nestedMap: { $sceneValue: "map", entries: [["part", { $sceneValue: "reference", actorId: "second", componentId: "part" }]] },
    absent: { $sceneValue: "undefined" },
  } }), () => ({ onCreation: () => { creations++; } }))!;
  const second = createActorFromSerialized(world, createActor("second", "Second", { properties: {
    target: { $sceneValue: "reference", actorId: "first" },
  }, components: [{ id: "part", classId: "MappedComponent", properties: {
    Targets: [{ key: "actor", value: { $sceneValue: "reference", actorId: "first" } }],
  } }] }))!;
  hydrateScenePropertyReferences([first, second]);
  expect(first.getVariable("target")).toBe(second);
  expect(second.getVariable("target")).toBe(first);
  expect(first.getVariable("nestedMap")).toEqual(new Map([["part", second.components[0]]]));
  expect(second.components[0]!.getVariable("Targets")).toEqual(new Map([["actor", first]]));
  expect(first.variables.has("absent")).toBe(true);
  expect(first.getVariable("absent")).toBeUndefined();
  expect(creations).toBe(0);
  world.spawnActorNow(first);
  expect(creations).toBe(1);
});

it("rejects an unresolved reference before applying any staged value and leaves ordinary values shared", () => {
  const world = new World({ seed: 1, dt: 1 / 60, classRegistry: new ClassRegistry() });
  const actor = world.createActor({ guid: "actor", classId: "Actor", variables: {
    valid: { $sceneValue: "reference", actorId: "actor" },
    invalid: { $sceneValue: "reference", actorId: "missing" },
    ordinary: { items: [1, 2] },
  } });
  const valid = actor.getVariable("valid"), ordinary = actor.getVariable("ordinary");
  expect(() => hydrateScenePropertyReferences([actor])).toThrow("missing actor");
  expect(actor.getVariable("valid")).toBe(valid);
  actor.variables.delete("invalid");
  hydrateScenePropertyReferences([actor]);
  expect(actor.getVariable("valid")).toBe(actor);
  expect(actor.getVariable("ordinary")).toBe(ordinary);
});
