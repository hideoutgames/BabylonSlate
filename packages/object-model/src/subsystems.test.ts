import { describe, expect, it } from "vitest";
import { ClassRegistry } from "./class-registry";
import {
  instantiableSubsystemClassIds,
  subsystemClassIdsForGet,
} from "./subsystems";

function registryWith(classes: ReadonlyArray<[id: string, parent: string]>) {
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

describe("instantiableSubsystemClassIds", () => {
  it("instantiates only user leaves of each base, in code-unit class id order", () => {
    const registry = registryWith([
      ["alpha", "GameSubsystem"],
      ["Zeta", "GameSubsystem"],
      ["BaseInventory", "GameSubsystem"],
      ["Inventory", "BaseInventory"],
      ["Weather", "SceneSubsystem"],
      ["Hero", "Actor"],
    ]);
    const classIds = registry.classIds();
    // Locale order would put "alpha" first; code-unit order puts uppercase first.
    expect(
      instantiableSubsystemClassIds(registry, classIds, "GameSubsystem"),
    ).toEqual(["Inventory", "Zeta", "alpha"]);
    expect(
      instantiableSubsystemClassIds(registry, classIds, "SceneSubsystem"),
    ).toEqual(["Weather"]);
  });

  it("works from an editor parent lookup whose chain stops at the engine base", () => {
    const parents: Record<string, string> = {
      Inventory: "BaseInventory",
      BaseInventory: "GameSubsystem",
      Weather: "SceneSubsystem",
    };
    const hierarchy = {
      ancestry(classId: string): string[] {
        const chain = [classId];
        for (let id = parents[classId]; id; id = parents[id]) chain.push(id);
        return chain;
      },
    };
    const classIds = ["Weather", "Inventory", "BaseInventory"];
    expect(
      instantiableSubsystemClassIds(hierarchy, classIds, "GameSubsystem"),
    ).toEqual(["Inventory"]);
    expect(
      subsystemClassIdsForGet(hierarchy, classIds, "BaseInventory"),
    ).toEqual(["Inventory"]);
  });
});

describe("subsystemClassIdsForGet", () => {
  const registry = registryWith([
    ["Audio", "GameSubsystem"],
    ["SfxAudio", "Audio"],
    ["MusicAudio", "Audio"],
    ["Save", "GameSubsystem"],
    ["Weather", "SceneSubsystem"],
    ["Hero", "Actor"],
  ]);
  const classIds = registry.classIds();

  it.each([
    ["an intermediate base with two leaves", "Audio", ["MusicAudio", "SfxAudio"]],
    ["a leaf", "SfxAudio", ["SfxAudio"]],
    ["a single-class subsystem", "Save", ["Save"]],
    ["a SceneSubsystem", "Weather", ["Weather"]],
    ["the engine base", "GameSubsystem", ["MusicAudio", "Save", "SfxAudio"]],
    ["a non-subsystem class", "Hero", []],
    ["an unknown class", "Missing", []],
  ])("resolves %s", (_label, requested, expected) => {
    expect(subsystemClassIdsForGet(registry, classIds, requested)).toEqual(
      expected,
    );
  });
});
