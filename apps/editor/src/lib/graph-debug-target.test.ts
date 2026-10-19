import { describe, expect, it } from "vitest";
import type { DebugInstance } from "@babylonslate/bridge";
import { classGraphDebugTarget, debugInstanceNames } from "./graph-debug-target";

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
    expect(classGraphDebugTarget("assets/Door.class.babasset", parentOf)).toEqual({ kind: "class", classId: "Door" });
  });

  it.each(["Helpers", "MoreHelpers", "Cheats", "Tooling"])("offers nothing for %s, which never has instances", (name) => {
    expect(classGraphDebugTarget(`assets/${name}.class.babasset`, parentOf)).toBeNull();
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
