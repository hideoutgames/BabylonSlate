import { describe, expect, it } from "vitest";
import type { DebugInstance } from "@haptic/bridge";
import { classGraphDebugTarget, debugInstanceNames, documentGraphDebugTarget } from "./graph-debug-target";

describe("classGraphDebugTarget", () => {
  const parents: Record<string, string> = {
    Door: "Actor",
    Helpers: "FunctionLibrary",
    MoreHelpers: "Helpers",
    Cheats: "BDebugCommand",
    Tooling: "EditorUtilityObject",
  };
  const parentOf = (id: string) => parents[id] ?? null;

  it("debugs a Class graph against the class named by its file", () => {
    expect(classGraphDebugTarget("assets/Door.class.hasset", parentOf)).toEqual({ kind: "class", classId: "Door" });
  });

  it.each(["Helpers", "MoreHelpers", "Cheats", "Tooling"])("offers nothing for %s, which never has instances", (name) => {
    expect(classGraphDebugTarget(`assets/${name}.class.hasset`, parentOf)).toBeNull();
  });
});

describe("documentGraphDebugTarget", () => {
  const registry = {
    generation: 1,
    list: () => [{ path: "assets/Door.class.hasset", header: { type: "Class", name: "Door", parentClass: "Actor" } }],
    getByPath: (path: string) => path.startsWith("assets/Guard") ? { header: { guid: `guid:${path}` } } : undefined,
  } as unknown as Parameters<typeof documentGraphDebugTarget>[1];

  it("debugs a Class graph against its class, and a tree or an Animation Graph against the asset's guid", () => {
    expect(documentGraphDebugTarget({ kind: "graph", path: "assets/Door.class.hasset" }, registry))
      .toEqual({ kind: "class", classId: "Door" });
    expect(documentGraphDebugTarget({ kind: "behaviour-tree", path: "assets/Guard.bt.hasset" }, registry))
      .toEqual({ kind: "behaviourTree", assetGuid: "guid:assets/Guard.bt.hasset" });
    expect(documentGraphDebugTarget({ kind: "anim-graph", path: "assets/Guard.anim.hasset" }, registry))
      .toEqual({ kind: "animationGraph", assetGuid: "guid:assets/Guard.anim.hasset" });
  });

  it("offers nothing for another document, an asset the registry does not know, or no document", () => {
    expect(documentGraphDebugTarget({ kind: "scene", path: "assets/Main.scene.hasset" }, registry)).toBeNull();
    expect(documentGraphDebugTarget({ kind: "blackboard", path: "assets/Guard.blackboard.hasset" }, registry)).toBeNull();
    expect(documentGraphDebugTarget({ kind: "behaviour-tree", path: "assets/Missing.bt.hasset" }, registry)).toBeNull();
    expect(documentGraphDebugTarget({ kind: "behaviour-tree", path: "assets/Guard.bt.hasset" }, null)).toBeNull();
    expect(documentGraphDebugTarget(undefined, registry)).toBeNull();
  });
});

describe("debugInstanceNames", () => {
  const actor = (id: string, label: string): DebugInstance => ({ id, kind: "actor", label });

  it("shows plain names where they are unique", () => {
    const names = debugInstanceNames([actor("a-1", "Front"), actor("b-2", "Back")]);
    expect([...names.values()]).toEqual(["Front", "Back"]);
  });

  it("tells repeated names apart by the start of the id and leaves the rest alone", () => {
    const names = debugInstanceNames([actor("aaaaaaaa-1111", "Door"), actor("bbbbbbbb-2222", "Door"), actor("c", "Lamp")]);
    expect(names.get("aaaaaaaa-1111")).toBe("Door · aaaaaaaa");
    expect(names.get("bbbbbbbb-2222")).toBe("Door · bbbbbbbb");
    expect(names.get("c")).toBe("Lamp");
  });

  it("names a component under its actor", () => {
    const names = debugInstanceNames([{ id: "h1", kind: "component", label: "Hinge", ownerLabel: "Front" }]);
    expect(names.get("h1")).toBe("Hinge (Front)");
  });
});
