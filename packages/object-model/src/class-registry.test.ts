import { describe, expect, it } from "vitest";
import { ClassRegistry, hydrateClassVariableValue } from "./class-registry";
import {
  ENGINE_COMPONENT_CLASS_IDS,
  isLockedEngineClassId,
} from "./ids";

describe("ClassRegistry", () => {
  it("registers engine bases and components by default", () => {
    const registry = new ClassRegistry();
    expect(registry.has("BObject")).toBe(true);
    expect(registry.has("Actor")).toBe(true);
    expect(registry.has("BDebugCommand")).toBe(true);
    expect(registry.isA("BDebugCommand", "BObject")).toBe(true);
    expect(registry.has("EditorUtilityObject")).toBe(true);
    expect(registry.isA("EditorUtilityObject", "BObject")).toBe(true);
    expect(registry.has("EditorFunctionLibrary")).toBe(true);
    expect(registry.isA("EditorFunctionLibrary", "FunctionLibrary")).toBe(true);
    expect(registry.isA("EditorFunctionLibrary", "BObject")).toBe(true);
    expect(registry.isA("Actor", "BObject")).toBe(true);
    expect(registry.isA("MeshComponent", "ActorComponent")).toBe(true);
    for (const id of ENGINE_COMPONENT_CLASS_IDS) {
      expect(registry.has(id)).toBe(true);
    }
    expect(registry.isA("BTTask", "BObject")).toBe(true);
    expect(registry.isA("BTDecorator", "BObject")).toBe(true);
    expect(registry.isA("BTService", "BObject")).toBe(true);
    expect(registry.isA("BTComposite", "BObject")).toBe(true);
    expect(registry.isA("BTTask_Wait", "BTTask")).toBe(true);
    expect(registry.isA("BTTask_MoveTo", "BTTask")).toBe(true);
    expect(registry.isA("BTDecorator_BlackboardIsSet", "BTDecorator")).toBe(true);
    expect(isLockedEngineClassId("MeshComponent")).toBe(true);
    expect(isLockedEngineClassId("BTTask_Wait")).toBe(true);
  });

  it("supports user class inheritance queries", () => {
    const registry = new ClassRegistry();
    expect(
      registry.register({
        id: "Enemy",
        parentClassId: "Actor",
        kind: "actor",
        variables: [{ name: "health", type: "float", defaultValue: 100 }],
        implementedInterfaces: [],
      }).ok,
    ).toBe(true);
    expect(registry.isA("Enemy", "Actor")).toBe(true);
    expect(registry.ancestry("Enemy")).toEqual(["Enemy", "Actor", "BObject"]);
    expect(registry.inheritedVariables("Enemy").map((v) => v.name)).toContain(
      "health",
    );
  });

  it("discovers user commands through the BDebugCommand parent chain", () => {
    const registry = new ClassRegistry();
    expect(
      registry.register({
        id: "HealCommand",
        parentClassId: "BDebugCommand",
        kind: "other",
        variables: [],
        implementedInterfaces: [],
      }).ok,
    ).toBe(true);
    expect(registry.isA("HealCommand", "BDebugCommand")).toBe(true);
    expect(registry.isA("HealCommand", "Actor")).toBe(false);
  });

  it("reparents with cycle detection and member invalidation", () => {
    const registry = new ClassRegistry();
    registry.register({
      id: "BaseA",
      parentClassId: "Actor",
      kind: "actor",
      variables: [{ name: "aOnly", type: "int", defaultValue: 1 }],
      implementedInterfaces: [],
    });
    registry.register({
      id: "BaseB",
      parentClassId: "Actor",
      kind: "actor",
      variables: [{ name: "bOnly", type: "int", defaultValue: 2 }],
      implementedInterfaces: [],
    });
    registry.register({
      id: "Child",
      parentClassId: "BaseA",
      kind: "actor",
      variables: [{ name: "mine", type: "int", defaultValue: 3 }],
      implementedInterfaces: [],
    });

    const cycle = registry.reparent("BaseA", "Child");
    expect(cycle.ok).toBe(false);

    const result = registry.reparent("Child", "BaseB");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.newParentId).toBe("BaseB");
      expect(result.value.invalidatedMembers).toEqual(["aOnly"]);
    }
    expect(registry.isA("Child", "BaseB")).toBe(true);
    expect(registry.isA("Child", "BaseA")).toBe(false);
  });

  it("rejects reparenting engine bases", () => {
    const registry = new ClassRegistry();
    expect(registry.reparent("Actor", "BObject").ok).toBe(false);
  });

  it("rejects reparenting engine components and BT builtins", () => {
    const registry = new ClassRegistry();
    expect(registry.reparent("MeshComponent", "Actor").ok).toBe(false);
    expect(registry.reparent("BTTask_Wait", "BTDecorator").ok).toBe(false);
  });

  it("ensure registers a new class and merges interfaces on a later call", () => {
    const registry = new ClassRegistry();
    expect(
      registry.ensure({
        id: "Enemy",
        parentClassId: "Actor",
        kind: "actor",
        variables: [{ name: "health", type: "float", defaultValue: 100 }],
        implementedInterfaces: ["iface-a"],
      }).ok,
    ).toBe(true);
    expect(
      registry.ensure({
        id: "Enemy",
        parentClassId: "Actor",
        kind: "actor",
        variables: [{ name: "armor", type: "float", defaultValue: 0 }],
        implementedInterfaces: ["iface-b"],
      }).ok,
    ).toBe(true);
    expect(registry.inheritedVariables("Enemy").map((v) => v.name)).toEqual(
      expect.arrayContaining(["health", "armor"]),
    );
    expect(registry.inheritedInterfaces("Enemy")).toEqual(
      expect.arrayContaining(["iface-a", "iface-b"]),
    );
  });

  it("inheritedInterfaces walks the parent chain", () => {
    const registry = new ClassRegistry();
    registry.register({
      id: "BaseEnemy",
      parentClassId: "Actor",
      kind: "actor",
      variables: [],
      implementedInterfaces: ["iface-base"],
    });
    registry.register({
      id: "Boss",
      parentClassId: "BaseEnemy",
      kind: "actor",
      variables: [],
      implementedInterfaces: ["iface-boss"],
    });
    expect(registry.inheritedInterfaces("Boss")).toEqual([
      "iface-base",
      "iface-boss",
    ]);
  });

  it("rejects register and reparent past the inheritance depth limit", () => {
    const registry = new ClassRegistry();
    let parent = "Actor";
    // Actor ancestry length 2; Deep0..Deep12 → Deep12 ancestry length 15.
    for (let i = 0; i < 13; i++) {
      const id = `Deep${i}`;
      expect(
        registry.register({
          id,
          parentClassId: parent,
          kind: "actor",
          variables: [],
          implementedInterfaces: [],
        }).ok,
      ).toBe(true);
      parent = id;
    }
    expect(registry.ancestry("Deep12").length).toBe(15);
    expect(
      registry.register({
        id: "Deep13",
        parentClassId: "Deep12",
        kind: "actor",
        variables: [],
        implementedInterfaces: [],
      }).ok,
    ).toBe(true);
    expect(registry.ancestry("Deep13").length).toBe(16);
    const blocked = registry.register({
      id: "Deep14",
      parentClassId: "Deep13",
      kind: "actor",
      variables: [],
      implementedInterfaces: [],
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error).toMatch(/inheritance depth limit/);
    }
    registry.register({
      id: "Shallow",
      parentClassId: "Actor",
      kind: "actor",
      variables: [],
      implementedInterfaces: [],
    });
    const reparent = registry.reparent("Shallow", "Deep13");
    expect(reparent.ok).toBe(false);
    if (!reparent.ok) {
      expect(reparent.error).toMatch(/inheritance depth limit/);
    }
  });

  it("hydrates Array and Map variable defaults at spawn", () => {
    expect(
      hydrateClassVariableValue({
        name: "hits",
        type: "rotator",
        container: "array",
      }),
    ).toEqual([]);
    expect(
      hydrateClassVariableValue({
        name: "hits",
        type: "rotator",
        container: "array",
        defaultValue: [{ pitch: 1, yaw: 0, roll: 0 }],
      }),
    ).toEqual([{ pitch: 1, yaw: 0, roll: 0 }]);
    const mapValue = hydrateClassVariableValue({
      name: "byName",
      type: "float",
      container: "map",
    });
    expect(mapValue).toBeInstanceOf(Map);
    expect(
      hydrateClassVariableValue({
        name: "health",
        type: "float",
        defaultValue: 8,
      }),
    ).toBe(8);
  });
});
