import { describe, expect, it } from "vitest";
import type { DebugInspectNode } from "@babylonslate/object-model";
import {
  flattenInspectTree,
  formatInspectVariable,
  nextInspectSelection,
} from "./play-inspect-tree";

const nodes: DebugInspectNode[] = [
  {
    id: "gi",
    kind: "gameInstance",
    label: "GameInstance",
    classId: "GameInstance",
    parentId: null,
    variables: { score: 1 },
  },
  {
    id: "hero",
    kind: "actor",
    label: "Hero",
    classId: "Actor",
    parentId: null,
    variables: { health: 10 },
  },
  {
    id: "mesh",
    kind: "component",
    label: "MeshComponent",
    classId: "MeshComponent",
    parentId: "hero",
    variables: { meshKind: "box" },
  },
  {
    id: "sword",
    kind: "actor",
    label: "Sword",
    classId: "Actor",
    parentId: "hero",
    variables: {},
  },
];

describe("flattenInspectTree", () => {
  it("keeps parent-before-child order with component depth under the actor", () => {
    const rows = flattenInspectTree(nodes, new Set(["hero"]), "");
    expect(rows.map((row) => [row.id, row.depth, row.hasChildren])).toEqual([
      ["gi", 0, false],
      ["hero", 0, true],
      ["mesh", 1, false],
      ["sword", 1, false],
    ]);
  });

  it("hides children of collapsed actors", () => {
    const rows = flattenInspectTree(nodes, new Set(), "");
    expect(rows.map((row) => row.id)).toEqual(["gi", "hero"]);
  });

  it("filters by label, class, or guid and keeps ancestors", () => {
    const rows = flattenInspectTree(nodes, new Set(["hero"]), "mesh");
    expect(rows.map((row) => row.id)).toEqual(["hero", "mesh"]);
  });
});

describe("nextInspectSelection", () => {
  it("keeps the previous guid when it still exists", () => {
    expect(nextInspectSelection("hero", nodes)).toBe("hero");
  });

  it("clears the selection when the guid is gone", () => {
    expect(nextInspectSelection("missing", nodes)).toBeNull();
    expect(nextInspectSelection(null, nodes)).toBeNull();
  });
});

describe("formatInspectVariable", () => {
  it("formats primitives and object refs for SelectableText", () => {
    expect(formatInspectVariable(4)).toBe("4");
    expect(formatInspectVariable(true)).toBe("true");
    expect(formatInspectVariable({ guid: "a1", classId: "Actor" })).toBe(
      "Actor(a1)",
    );
  });
});
