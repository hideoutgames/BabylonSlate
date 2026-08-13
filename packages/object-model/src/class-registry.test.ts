import { describe, expect, it } from "vitest";
import { ClassRegistry } from "./class-registry";
import { ENGINE_COMPONENT_CLASS_IDS } from "./ids";

describe("ClassRegistry", () => {
  it("registers engine bases and components by default", () => {
    const registry = new ClassRegistry();
    expect(registry.has("BObject")).toBe(true);
    expect(registry.has("Actor")).toBe(true);
    expect(registry.has("BDebugCommand")).toBe(true);
    expect(registry.isA("BDebugCommand", "BObject")).toBe(true);
    expect(registry.isA("Actor", "BObject")).toBe(true);
    expect(registry.isA("MeshComponent", "ActorComponent")).toBe(true);
    for (const id of ENGINE_COMPONENT_CLASS_IDS) {
      expect(registry.has(id)).toBe(true);
    }
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
});
