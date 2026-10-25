import { describe, expect, it } from "vitest";
import { ClassRegistry, hydrateClassVariableValue, type VariableDef } from "./class-registry";
import {
  ENGINE_COMPONENT_CLASS_IDS,
  isHiddenEngineBaseClassId,
  isLockedEngineClassId,
} from "./ids";

describe("ClassRegistry", () => {
  it("registers engine bases and components by default", () => {
    const registry = new ClassRegistry();
    expect(registry.has("Object")).toBe(true);
    expect(registry.has("Actor")).toBe(true);
    expect(registry.has("DebugCommand")).toBe(true);
    expect(registry.isA("DebugCommand", "Object")).toBe(true);
    expect(registry.has("EditorUtilityObject")).toBe(true);
    expect(registry.isA("EditorUtilityObject", "Object")).toBe(true);
    expect(registry.has("EditorFunctionLibrary")).toBe(true);
    expect(registry.isA("EditorFunctionLibrary", "FunctionLibrary")).toBe(true);
    expect(registry.isA("EditorFunctionLibrary", "Object")).toBe(true);
    expect(registry.isA("Actor", "Object")).toBe(true);
    expect(registry.isA("RenderTargetCapture", "Actor")).toBe(true);
    expect(registry.isA("MeshComponent", "ActorComponent")).toBe(true);
    for (const id of ENGINE_COMPONENT_CLASS_IDS) {
      expect(registry.has(id)).toBe(true);
    }
    expect(registry.isA("BTTask", "Object")).toBe(true);
    expect(registry.isA("BTDecorator", "Object")).toBe(true);
    expect(registry.isA("BTService", "Object")).toBe(true);
    expect(registry.isA("BTComposite", "Object")).toBe(true);
    expect(registry.isA("BTTask_Wait", "BTTask")).toBe(true);
    expect(registry.isA("BTTask_MoveTo", "BTTask")).toBe(true);
    expect(registry.isA("BTDecorator_BlackboardIsSet", "BTDecorator")).toBe(true);
    expect(isLockedEngineClassId("MeshComponent")).toBe(true);
    expect(isLockedEngineClassId("BTTask_Wait")).toBe(true);
    expect(registry.has("SceneLayer")).toBe(true);
    expect(registry.has("Scene")).toBe(true);
    expect(registry.isA("Scene", "Object")).toBe(true);
    expect(registry.has("SceneLayerActor")).toBe(true);
    expect(registry.isA("SceneLayer", "Object")).toBe(true);
    expect(registry.isA("SceneLayerActor", "Actor")).toBe(true);
    expect(registry.isA("2DAnchorComponent", "ActorComponent")).toBe(true);
    expect(registry.isA("2DButtonComponent", "ActorComponent")).toBe(true);
    expect(registry.isA("2DMaterialComponent", "ActorComponent")).toBe(true);
    expect(registry.isA("2DTextureComponent", "ActorComponent")).toBe(true);
    expect(registry.isA("2DTextComponent", "ActorComponent")).toBe(true);
    expect(registry.isA("2DRichTextComponent", "ActorComponent")).toBe(true);
    expect(registry.isA("2DPanelComponent", "ActorComponent")).toBe(true);
    expect(isLockedEngineClassId("SceneLayer")).toBe(true);
    expect(isLockedEngineClassId("Scene")).toBe(true);
    expect(isLockedEngineClassId("SceneLayerActor")).toBe(true);
    expect(isLockedEngineClassId("2DButtonComponent")).toBe(true);
  });

  it("parents both subsystem bases to the hidden locked Subsystem base", () => {
    const registry = new ClassRegistry();
    registry.register({
      id: "Inventory",
      parentClassId: "GameSubsystem",
      kind: "object",
      variables: [],
      implementedInterfaces: [],
    });
    expect(registry.ancestry("Inventory")).toEqual([
      "Inventory",
      "GameSubsystem",
      "Subsystem",
      "Object",
    ]);
    expect(registry.ancestry("SceneSubsystem")).toEqual([
      "SceneSubsystem",
      "Subsystem",
      "Object",
    ]);
    expect(registry.isA("GameSubsystem", "GameInstance")).toBe(false);
    for (const id of ["Subsystem", "GameSubsystem", "SceneSubsystem"]) {
      expect(isLockedEngineClassId(id)).toBe(true);
      expect(registry.reparent(id, "Actor").ok).toBe(false);
    }
    expect(isHiddenEngineBaseClassId("Subsystem")).toBe(true);
    expect(isHiddenEngineBaseClassId("GameSubsystem")).toBe(false);
    expect(isHiddenEngineBaseClassId("SceneSubsystem")).toBe(false);
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
    expect(registry.ancestry("Enemy")).toEqual(["Enemy", "Actor", "Object"]);
    expect(registry.inheritedVariables("Enemy").map((v) => v.name)).toContain(
      "health",
    );
  });

  it("discovers user commands through the DebugCommand parent chain", () => {
    const registry = new ClassRegistry();
    expect(
      registry.register({
        id: "HealCommand",
        parentClassId: "DebugCommand",
        kind: "other",
        variables: [],
        implementedInterfaces: [],
      }).ok,
    ).toBe(true);
    expect(registry.isA("HealCommand", "DebugCommand")).toBe(true);
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
    expect(registry.reparent("Actor", "Object").ok).toBe(false);
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
    // The moved class carries its subtree: its child must stay within the limit too.
    registry.register({
      id: "ShallowChild",
      parentClassId: "Shallow",
      kind: "actor",
      variables: [],
      implementedInterfaces: [],
    });
    expect(registry.reparent("Shallow", "Deep12").ok).toBe(false);
    expect(registry.ancestry("ShallowChild").length).toBe(4);
    expect(registry.reparent("Shallow", "Deep11").ok).toBe(true);
    expect(registry.ancestry("ShallowChild").length).toBe(16);
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
    expect((mapValue as Map<unknown, unknown>).size).toBe(0);
    const filledMap = hydrateClassVariableValue({
      name: "byName",
      type: "float",
      container: "map",
      defaultValue: [
        { key: "a", value: 1 },
        { key: "a", value: 2 },
      ],
    });
    expect(filledMap).toBeInstanceOf(Map);
    expect((filledMap as Map<unknown, unknown>).get("a")).toBe(2);
    expect(
      hydrateClassVariableValue({
        name: "health",
        type: "float",
        defaultValue: 8,
      }),
    ).toBe(8);
  });

  it("gives every spawn its own copy of object, array element and map value defaults", () => {
    const defaults: VariableDef[] = [
      { name: "home", type: "vec3", defaultValue: { x: 1, y: 2, z: 3 } },
      { name: "path", type: "vec3", container: "array", defaultValue: [{ x: 0, y: 0, z: 0 }] },
      { name: "spawns", type: "vec3", container: "map", defaultValue: [{ key: "a", value: { x: 5, y: 0, z: 0 } }] },
    ];
    const [home, path, spawns] = defaults.map(hydrateClassVariableValue) as [
      { x: number },
      Array<{ x: number }>,
      Map<string, { x: number }>,
    ];
    home.x = 9;
    path[0]!.x = 9;
    spawns.get("a")!.x = 9;
    expect(defaults.map(hydrateClassVariableValue)).toEqual([
      { x: 1, y: 2, z: 3 },
      [{ x: 0, y: 0, z: 0 }],
      new Map([["a", { x: 5, y: 0, z: 0 }]]),
    ]);
  });
});
